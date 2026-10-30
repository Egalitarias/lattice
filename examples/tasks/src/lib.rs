//! Lattice reference app: tasks backed by a server, over typed RPC, with sign-in.
//!
//! The component holds only a cache of what the server last said. Every change goes through
//! `rpc.call`; the host validates requests and responses against the API description in `api.json`.
//!
//! Sign-in never touches a credential or a token here. The component asks the host to run a
//! passkey ceremony or an OIDC flow, forwards the host's result to its server, and the server
//! replies with a session that the host (not this code) keeps. The component learns who the user
//! is by asking its server (`profile`).

wit_bindgen::generate!({
    path: "../../spec/wit",
    world: "app",
});

use std::cell::RefCell;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use exports::lattice::app::lifecycle::{ActionCall, Guest, HostEvent, Launch, RouteRequest};
use lattice::app::analytics;
use lattice::app::auth;
use lattice::app::log::{self, Level};
use lattice::app::payments;
use lattice::app::rpc::{self, RpcError};
use lattice::app::scene::*;
use lattice::app::session;
use lattice::app::types::{AppError, HostError, Scalar};

// Fixed ids for the static parts of the home scene.
const ROOT: NodeId = 1;
const HEADER: NodeId = 2;
const TITLE: NodeId = 3;
const MAIN: NodeId = 4;
const FORM: NodeId = 5;
const INPUT: NodeId = 6;
const ADD: NodeId = 7;
const SUMMARY: NodeId = 8;
const LIST: NodeId = 9;
const FOOTER: NodeId = 10;
const ABOUT_LINK: NodeId = 11;
const ACCOUNT: NodeId = 20;
// The account section's children occupy ids 29..49 and are replaced wholesale on every change.
const ACC_STACK: NodeId = 29;
const ACC_STATUS: NodeId = 30;
const ACC_SIGN_OUT: NodeId = 31;
const ACC_UPGRADE: NodeId = 32;
const ACC_PASSKEY_LOGIN: NodeId = 33;
const ACC_REGISTER_FORM: NodeId = 34;
const ACC_REGISTER_NAME: NodeId = 35;
const ACC_REGISTER_BUTTON: NodeId = 36;
const ACC_PENDING: NodeId = 37;
const ACC_CHECK: NodeId = 38;
const ACC_NOTE: NodeId = 39;
const ACC_OIDC_BASE: NodeId = 40;
// Task `n` occupies ids ROW_BASE + n*4 .. +2 (row, checkbox, delete button).
const ROW_BASE: NodeId = 1000;

#[derive(Clone, Deserialize)]
struct Task {
    id: u32,
    title: String,
    done: bool,
}

#[derive(Default)]
struct State {
    tasks: Vec<Task>,
    signed_in: bool,
    name: String,
    pro: bool,
    /// An order the user has paid for (as far as the host can tell) but the server has not confirmed yet.
    pending_order: Option<String>,
    /// A message about the last payment attempt, shown in the account section.
    note: Option<String>,
    oidc_issuers: Vec<String>,
    /// Ids of the dynamic nodes currently in the host's scene, so the next update can remove them.
    rendered: Vec<NodeId>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

// ---- Typed RPC --------------------------------------------------------------------------------

#[derive(Serialize)]
struct Empty {}
#[derive(Serialize)]
struct AddTask<'a> {
    title: &'a str,
}
#[derive(Serialize)]
struct SetDone {
    id: u32,
    done: bool,
}
#[derive(Serialize)]
struct DeleteTask {
    id: u32,
}
#[derive(Serialize)]
struct RegisterBegin<'a> {
    name: &'a str,
}
#[derive(Serialize)]
struct Finish<'a> {
    response: &'a str,
}
#[derive(Deserialize)]
struct TaskList {
    tasks: Vec<Task>,
}
#[derive(Deserialize)]
struct TaskReply {
    task: Task,
}
#[derive(Deserialize)]
struct Nothing {}
#[derive(Deserialize)]
struct Profile {
    signed_in: bool,
    name: String,
    pro: bool,
}
#[derive(Serialize)]
struct CreateOrder<'a> {
    sku: &'a str,
}
#[derive(Serialize)]
struct OrderRef<'a> {
    order_ref: &'a str,
}
#[derive(Deserialize)]
struct Order {
    order_ref: String,
}
#[derive(Deserialize)]
struct OrderStatus {
    status: String,
}
#[derive(Deserialize)]
struct Options {
    options: String,
}
#[derive(Deserialize)]
#[allow(dead_code)]
struct Named {
    name: String,
}

/// Record a product event. The host checks it against the manifest's catalog and the user's analytics
/// level, redacts it, and decides whether anything is sent. This code cannot tell, and does not need to.
fn track(name: &str, props: &[(&str, Scalar)]) {
    let props: Vec<(String, Scalar)> = props.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    analytics::emit(name, &props);
}

/// A failure that is the app's or the host's fault rather than the user's: reported (the host scrubs it)
/// and returned.
fn internal(name: &str, detail: String) -> AppError {
    analytics::report_error(name, &detail);
    AppError::Internal(detail)
}

/// Encode `req`, call `method`, decode the reply. Server-declared errors become messages for the
/// user; everything else is logged and shown as a generic failure.
fn api<Req: Serialize, Res: DeserializeOwned>(method: &str, req: &Req) -> Result<Res, AppError> {
    let mut body = Vec::new();
    ciborium::into_writer(req, &mut body).map_err(|e| internal("rpc_encode", format!("encode {method}: {e}")))?;
    match rpc::call(method, &body) {
        Ok(bytes) => ciborium::from_reader(bytes.as_slice()).map_err(|e| internal("rpc_decode", format!("decode {method}: {e}"))),
        Err(RpcError::Application(e)) if e.code == "unauthorized" => Err(AppError::Unauthorized),
        Err(RpcError::Application(e)) => Err(AppError::Invalid(e.message)),
        Err(RpcError::Transport(msg)) => {
            log::write(Level::Warn, &format!("{method}: {msg}"));
            Err(AppError::Invalid("Could not reach the server. Please try again.".into()))
        }
        Err(RpcError::Host(e)) => Err(internal("rpc_host", format!("{method}: {e:?}"))),
    }
}

/// A failure from a host call that asks the user for something ("Sign-in", "Payment"), as a message for the user.
fn host_err_for(what: &str, e: HostError) -> AppError {
    match e {
        HostError::Cancelled => AppError::Invalid(format!("{what} was cancelled.")),
        HostError::Unavailable(m) => AppError::Invalid(format!("{what} is not available: {m}")),
        HostError::InvalidArgument(m) => AppError::Invalid(format!("{what} failed: {m}")),
        HostError::CapabilityDenied(c) | HostError::CapabilityRevoked(c) => AppError::Invalid(format!("Not permitted: {c}")),
        HostError::RateLimited => AppError::Invalid("Please wait a moment and try again.".into()),
        HostError::Internal(m) => internal("host_internal", m),
    }
}

fn host_err(e: HostError) -> AppError {
    host_err_for("Sign-in", e)
}

fn reload() -> Result<(), AppError> {
    let list: TaskList = api("list_tasks", &Empty {})?;
    STATE.with(|s| s.borrow_mut().tasks = list.tasks);
    Ok(())
}

fn load_profile() -> Result<(), AppError> {
    let p: Profile = api("profile", &Empty {})?;
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.signed_in = p.signed_in;
        s.name = p.name;
        s.pro = p.pro;
    });
    Ok(())
}

// ---- Scene helpers ----------------------------------------------------------------------------

fn common() -> Common {
    Common { hidden: false, width: None, height: None, padding: None, tone: None, label: None, description: None, lang: None }
}

fn node(id: NodeId, body: Body, children: &[NodeId]) -> Node {
    Node { id, common: common(), body, children: children.to_vec() }
}

fn padded(id: NodeId, body: Body, children: &[NodeId]) -> Node {
    let mut c = common();
    c.padding = Some(Token::Lg);
    Node { id, common: c, body, children: children.to_vec() }
}

fn act(name: &str, args: &[(&str, Scalar)]) -> ActionRef {
    ActionRef { action: name.to_string(), args: args.iter().map(|(k, v)| (k.to_string(), v.clone())).collect() }
}

fn stack(axis: Axis, gap: Token) -> Body {
    Body::Stack(Stack { axis, gap, align: Align::Stretch, justify: Justify::Start, wrap: false })
}

fn text(s: &str) -> Body {
    Body::Text(Text { text: s.to_string(), style: TextStyle::Body, emphasis: TextEmphasis::None, max_lines: None, selectable: true })
}

fn region(role: Landmark, label: &str) -> Body {
    Body::Region(Region { role, label: label.to_string() })
}

fn heading(level: u8, s: &str) -> Body {
    Body::Heading(Heading { level, text: s.to_string() })
}

fn link(target: &str, label: &str) -> Body {
    Body::Link(Link { target: target.into(), label: label.into(), text: None, external: false })
}

fn button(label: &str, text: &str, emphasis: ButtonEmphasis, action: ActionRef) -> Body {
    Body::Button(Button { label: label.into(), text: Some(text.into()), emphasis, disabled: false, on_press: action })
}

fn host_of(issuer: &str) -> &str {
    issuer.split("://").last().unwrap_or(issuer).split('/').next().unwrap_or(issuer)
}

// ---- Scenes -----------------------------------------------------------------------------------

fn summary_node() -> Node {
    let t = STATE.with(|s| {
        let s = s.borrow();
        let done = s.tasks.iter().filter(|t| t.done).count();
        let n = s.tasks.len();
        format!("{} task{}, {} done", n, if n == 1 { "" } else { "s" }, done)
    });
    node(SUMMARY, text(&t), &[])
}

/// The account section's nodes. The first is the stack that sits inside the ACCOUNT region.
fn account_nodes() -> Vec<Node> {
    STATE.with(|s| {
        let s = s.borrow();
        let mut nodes = Vec::new();
        if s.signed_in {
            let status = if s.pro { format!("Signed in as {} (Pro)", s.name) } else { format!("Signed in as {}", s.name) };
            let mut kids = vec![ACC_STATUS];
            if s.note.is_some() {
                kids.push(ACC_NOTE);
            }
            if let Some(_) = &s.pending_order {
                kids.push(ACC_PENDING);
                kids.push(ACC_CHECK);
            } else if !s.pro {
                kids.push(ACC_UPGRADE);
            }
            kids.push(ACC_SIGN_OUT);
            nodes.push(node(ACC_STACK, stack(Axis::Vertical, Token::Sm), &kids));
            nodes.push(node(ACC_STATUS, text(&status), &[]));
            if let Some(n) = &s.note {
                nodes.push(node(ACC_NOTE, text(n), &[]));
            }
            if s.pending_order.is_some() {
                nodes.push(node(ACC_PENDING, text("Payment submitted. Waiting for the server to confirm it."), &[]));
                nodes.push(node(ACC_CHECK, button("Check payment", "Check payment", ButtonEmphasis::Secondary, act("check_payment", &[])), &[]));
            } else if !s.pro {
                nodes.push(node(
                    ACC_UPGRADE,
                    button("Upgrade to Pro for $4.00", "Upgrade to Pro ($4.00)", ButtonEmphasis::Primary, act("buy_pro", &[])),
                    &[],
                ));
            }
            nodes.push(node(ACC_SIGN_OUT, button("Sign out", "Sign out", ButtonEmphasis::Secondary, act("sign_out", &[])), &[]));
        } else {
            let mut kids = vec![ACC_STATUS, ACC_PASSKEY_LOGIN, ACC_REGISTER_FORM];
            for i in 0..s.oidc_issuers.len() {
                kids.push(ACC_OIDC_BASE + i as u32);
            }
            nodes.push(node(ACC_STACK, stack(Axis::Vertical, Token::Sm), &kids));
            nodes.push(node(ACC_STATUS, text("You are not signed in. Your tasks are kept for this device only."), &[]));
            nodes.push(node(
                ACC_PASSKEY_LOGIN,
                button("Sign in with a passkey", "Sign in with a passkey", ButtonEmphasis::Primary, act("passkey_login", &[])),
                &[],
            ));
            nodes.push(node(
                ACC_REGISTER_FORM,
                Body::Form(Form { label: "Create an account with a passkey".into(), on_submit: act("passkey_register", &[]) }),
                &[ACC_REGISTER_NAME, ACC_REGISTER_BUTTON],
            ));
            nodes.push(node(
                ACC_REGISTER_NAME,
                Body::Input(Input {
                    name: "account_name".into(),
                    kind: InputKind::Text,
                    label: "Account name".into(),
                    value: Some(String::new()),
                    placeholder: None,
                    required: true,
                    sensitive: false,
                    autocomplete: Some("username".into()),
                    min: None,
                    max: None,
                    max_length: Some(80),
                    on_change: None,
                }),
                &[],
            ));
            nodes.push(node(
                ACC_REGISTER_BUTTON,
                button("Create account with a passkey", "Create passkey", ButtonEmphasis::Secondary, act("passkey_register", &[])),
                &[],
            ));
            for (i, issuer) in s.oidc_issuers.iter().enumerate() {
                let label = format!("Sign in with {}", host_of(issuer));
                nodes.push(node(
                    ACC_OIDC_BASE + i as u32,
                    button(&label, &label, ButtonEmphasis::Secondary, act("oidc_login", &[("issuer", Scalar::Text(issuer.clone()))])),
                    &[],
                ));
            }
        }
        nodes
    })
}

/// Nodes for every task row, plus the row ids (the list's children).
fn task_nodes() -> (Vec<Node>, Vec<NodeId>) {
    STATE.with(|s| {
        let s = s.borrow();
        let mut nodes = Vec::new();
        let mut rows = Vec::new();
        for t in &s.tasks {
            let row = ROW_BASE + t.id * 4;
            let (check, del) = (row + 1, row + 2);
            let tid = Scalar::Integer(t.id as i64);
            nodes.push(node(row, stack(Axis::Horizontal, Token::Sm), &[check, del]));
            nodes.push(node(
                check,
                Body::Checkbox(Checkbox {
                    name: format!("done_{}", t.id),
                    label: t.title.clone(),
                    checked: t.done,
                    on_change: Some(act("toggle_task", &[("id", tid.clone())])),
                }),
                &[],
            ));
            nodes.push(node(
                del,
                button(&format!("Delete {}", t.title), "Delete", ButtonEmphasis::Plain, act("delete_task", &[("id", tid)])),
                &[],
            ));
            rows.push(row);
        }
        (nodes, rows)
    })
}

fn list_node(rows: &[NodeId]) -> Node {
    node(LIST, Body::ItemList(ItemList { ordered: false }), rows)
}

fn input_node() -> Node {
    node(
        INPUT,
        Body::Input(Input {
            name: "title".into(),
            kind: InputKind::Text,
            label: "What needs doing?".into(),
            value: Some(String::new()),
            placeholder: None,
            required: true,
            sensitive: false,
            autocomplete: Some("off".into()),
            min: None,
            max: None,
            max_length: Some(200),
            on_change: None,
        }),
        &[],
    )
}

fn home_scene() -> Scene {
    let (tasks, rows) = task_nodes();
    let account = account_nodes();
    STATE.with(|s| s.borrow_mut().rendered = tasks.iter().chain(account.iter()).map(|n| n.id).collect());

    let mut nodes = vec![
        padded(ROOT, stack(Axis::Vertical, Token::Md), &[HEADER, ACCOUNT, MAIN, FOOTER]),
        node(HEADER, region(Landmark::Banner, "Site header"), &[TITLE]),
        node(TITLE, heading(1, "Lattice Tasks"), &[]),
        node(ACCOUNT, region(Landmark::Complementary, "Account"), &[ACC_STACK]),
        node(MAIN, region(Landmark::Main, "Task list"), &[FORM, SUMMARY, LIST]),
        node(FORM, Body::Form(Form { label: "Add a task".into(), on_submit: act("add_task", &[]) }), &[INPUT, ADD]),
        input_node(),
        node(ADD, button("Add task", "Add", ButtonEmphasis::Primary, act("add_task", &[])), &[]),
        summary_node(),
        list_node(&rows),
        node(FOOTER, region(Landmark::Contentinfo, "Site footer"), &[ABOUT_LINK]),
        node(ABOUT_LINK, link("/about", "About this app"), &[]),
    ];
    nodes.extend(account);
    nodes.extend(tasks);
    Scene { title: "Lattice Tasks".into(), lang: Some("en".into()), live: Some(SUMMARY), root: ROOT, nodes }
}

fn about_scene() -> Scene {
    let nodes = vec![
        padded(1, stack(Axis::Vertical, Token::Md), &[2, 3]),
        node(2, region(Landmark::Main, "About"), &[4, 5, 6, 8]),
        node(3, region(Landmark::Navigation, "Navigation"), &[7]),
        node(4, heading(1, "About"), &[]),
        node(5, text("Your tasks live on the server. This component asks for them over typed RPC and draws what it gets back."), &[]),
        node(6, text("Every request and response is validated against the API description before it crosses the boundary."), &[]),
        node(8, text("Signing in is done by the host, not by this component. The component never sees a password, a passkey or a session token."), &[]),
        node(7, link("/", "Back to the task list"), &[]),
    ];
    Scene { title: "About".into(), lang: Some("en".into()), live: None, root: 1, nodes }
}

/// Replace the dynamic parts of the scene: remove old nodes, add the current ones, refresh the list
/// and summary. Used after anything that can change the account or the tasks.
fn refresh(focus: Option<NodeId>) -> Update {
    let (tasks, rows) = task_nodes();
    let account = account_nodes();
    let fresh: Vec<NodeId> = tasks.iter().chain(account.iter()).map(|n| n.id).collect();
    let old = STATE.with(|s| std::mem::replace(&mut s.borrow_mut().rendered, fresh));
    let mut ops: Vec<PatchOp> = old.into_iter().map(PatchOp::RemoveNode).collect();
    ops.extend(account.into_iter().map(PatchOp::SetNode));
    ops.extend(tasks.into_iter().map(PatchOp::SetNode));
    ops.push(PatchOp::SetNode(list_node(&rows)));
    ops.push(PatchOp::SetNode(summary_node()));
    Update { ops, focus }
}

// ---- Component --------------------------------------------------------------------------------

fn arg_int(call: &ActionCall, name: &str) -> Option<u32> {
    call.args.iter().find_map(|(k, v)| match v {
        Scalar::Integer(i) if k == name => u32::try_from(*i).ok(),
        _ => None,
    })
}

fn arg_text(call: &ActionCall, name: &str) -> Option<String> {
    call.args.iter().find_map(|(k, v)| match v {
        Scalar::Text(t) if k == name => Some(t.clone()),
        _ => None,
    })
}

fn value_text(call: &ActionCall, name: &str) -> Option<String> {
    call.values.iter().find_map(|(k, v)| match v {
        Scalar::Text(t) if k == name => Some(t.clone()),
        _ => None,
    })
}

fn value_bool(call: &ActionCall) -> Option<bool> {
    call.values.iter().find_map(|(_, v)| match v {
        Scalar::Boolean(b) => Some(*b),
        _ => None,
    })
}

/// The session changed (by sign-in, sign-out or the host). Everything that depends on who the user is
/// has to be asked for again.
fn after_session_change() -> Result<Update, AppError> {
    load_profile()?;
    reload()?;
    Ok(refresh(None))
}

/// Ask the server whether the pending order was paid. If it was, learn what that unlocked.
fn confirm_payment() -> Result<Update, AppError> {
    let order = STATE.with(|s| s.borrow().pending_order.clone());
    let Some(order) = order else { return Ok(refresh(None)) };
    let st: OrderStatus = api("order_status", &OrderRef { order_ref: &order })?;
    match st.status.as_str() {
        "paid" => {
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.pending_order = None;
                s.note = None;
            });
            load_profile()?;
            track("upgrade_confirmed", &[]);
            Ok(refresh(None))
        }
        "failed" | "expired" => {
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.pending_order = None;
                s.note = Some("The payment did not go through, so Pro was not unlocked.".into());
            });
            Ok(refresh(None))
        }
        // created or pending: the processor's confirmation has not reached the server yet
        _ => Ok(refresh(None)),
    }
}

fn options_text(o: Options) -> Vec<u8> {
    o.options.into_bytes()
}

fn response_text(bytes: Vec<u8>) -> Result<String, AppError> {
    String::from_utf8(bytes).map_err(|_| internal("host_non_utf8", "host returned non-UTF-8".into()))
}

struct TasksApp;

impl Guest for TasksApp {
    fn init(launch: Launch) -> Result<(), AppError> {
        log::write(Level::Info, &format!("tasks starting for {} ({})", launch.origin, launch.locale));
        STATE.with(|s| s.borrow_mut().oidc_issuers = launch.oidc_issuers);
        Ok(())
    }

    fn route(request: RouteRequest) -> Result<Scene, AppError> {
        match request.handler.as_str() {
            "Home" => {
                load_profile()?;
                reload()?;
                Ok(home_scene())
            }
            "About" => Ok(about_scene()),
            _ => Err(AppError::NotFound),
        }
    }

    fn dispatch(call: ActionCall) -> Result<Update, AppError> {
        match call.action.as_str() {
            "add_task" => {
                let title = value_text(&call, "title").unwrap_or_default();
                if title.trim().is_empty() {
                    return Err(AppError::Invalid("Enter something to do first.".into()));
                }
                let reply: TaskReply = api("add_task", &AddTask { title: &title })?;
                STATE.with(|s| s.borrow_mut().tasks.push(reply.task));
                let n = STATE.with(|s| s.borrow().tasks.len());
                track("task_added", &[("tasks", Scalar::Integer(n as i64))]);
                let mut update = refresh(Some(INPUT));
                // Re-sending the input with an empty value clears the field.
                update.ops.push(PatchOp::SetNode(input_node()));
                Ok(update)
            }
            "toggle_task" => {
                let id = arg_int(&call, "id").ok_or_else(|| AppError::Invalid("missing id".into()))?;
                let done = value_bool(&call).unwrap_or(true);
                let reply: TaskReply = api("set_done", &SetDone { id, done })?;
                STATE.with(|s| {
                    if let Some(t) = s.borrow_mut().tasks.iter_mut().find(|t| t.id == id) {
                        *t = reply.task;
                    }
                });
                track("task_done", &[("done", Scalar::Boolean(done))]);
                Ok(refresh(None))
            }
            "delete_task" => {
                let id = arg_int(&call, "id").ok_or_else(|| AppError::Invalid("missing id".into()))?;
                let _: Nothing = api("delete_task", &DeleteTask { id })?;
                STATE.with(|s| s.borrow_mut().tasks.retain(|t| t.id != id));
                track("task_deleted", &[]);
                Ok(refresh(Some(INPUT)))
            }

            // ---- Accounts ------------------------------------------------------------------
            "passkey_register" => {
                let name = value_text(&call, "account_name").unwrap_or_default();
                if name.trim().is_empty() {
                    return Err(AppError::Invalid("Choose an account name first.".into()));
                }
                let begin: Options = api("passkey_register_begin", &RegisterBegin { name: name.trim() })?;
                let created = auth::passkey_create(&options_text(begin)).map_err(host_err)?;
                let _: Named = api("passkey_register_finish", &Finish { response: &response_text(created)? })?;
                track("signed_in", &[("method", Scalar::Text("passkey".into()))]);
                after_session_change()
            }
            "passkey_login" => {
                let begin: Options = api("passkey_login_begin", &Empty {})?;
                let asserted = auth::passkey_assert(&options_text(begin)).map_err(host_err)?;
                let _: Named = api("passkey_login_finish", &Finish { response: &response_text(asserted)? })?;
                track("signed_in", &[("method", Scalar::Text("passkey".into()))]);
                after_session_change()
            }
            "oidc_login" => {
                let issuer = arg_text(&call, "issuer").ok_or_else(|| AppError::Invalid("missing issuer".into()))?;
                auth::sign_in_oidc(&issuer).map_err(host_err)?;
                track("signed_in", &[("method", Scalar::Text("oidc".into()))]);
                after_session_change()
            }
            "sign_out" => {
                session::sign_out();
                track("signed_out", &[]);
                STATE.with(|s| {
                    let mut s = s.borrow_mut();
                    s.pending_order = None;
                    s.note = None;
                });
                after_session_change()
            }

            // ---- Payments ------------------------------------------------------------------
            // The server prices the order. The host shows the user what the server says and takes them to the
            // processor. What comes back is "the user returned", not "the user paid": the server decides that.
            "buy_pro" => {
                track("upgrade_started", &[]);
                let order: Order = api("create_order", &CreateOrder { sku: "pro" })?;
                payments::request(&order.order_ref).map_err(|e| host_err_for("Payment", e))?;
                STATE.with(|s| {
                    let mut s = s.borrow_mut();
                    s.pending_order = Some(order.order_ref);
                    s.note = None;
                });
                confirm_payment()
            }
            "check_payment" => confirm_payment(),
            other => {
                log::write(Level::Warn, &format!("unknown action {other}"));
                Err(AppError::Invalid(format!("unknown action {other}")))
            }
        }
    }

    fn on_event(event: HostEvent) -> Result<Update, AppError> {
        match event {
            HostEvent::SessionChanged(_) => after_session_change(),
            _ => Ok(Update { ops: vec![], focus: None }),
        }
    }
}

export!(TasksApp);
