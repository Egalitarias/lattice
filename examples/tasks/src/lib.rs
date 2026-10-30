//! Lattice reference app: tasks backed by a server, over typed RPC.
//!
//! The component holds only a cache of what the server last said. Every change goes through
//! `rpc.call`; the host validates requests and responses against the API description in `api.json`,
//! so a response that reaches this code already has the right shape.

wit_bindgen::generate!({
    path: "../../spec/wit",
    world: "app",
});

use std::cell::RefCell;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use exports::lattice::app::lifecycle::{ActionCall, Guest, HostEvent, Launch, RouteRequest};
use lattice::app::log::{self, Level};
use lattice::app::rpc::{self, RpcError};
use lattice::app::scene::*;
use lattice::app::types::{AppError, Scalar};

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
    /// Ids of the task nodes currently in the host's scene, so the next update can remove them.
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

/// Encode `req`, call `method`, decode the reply. Server-declared errors become messages for the
/// user; everything else is logged and shown as a generic failure.
fn api<Req: Serialize, Res: DeserializeOwned>(method: &str, req: &Req) -> Result<Res, AppError> {
    let mut body = Vec::new();
    ciborium::into_writer(req, &mut body).map_err(|e| AppError::Internal(format!("encode {method}: {e}")))?;
    match rpc::call(method, &body) {
        Ok(bytes) => ciborium::from_reader(bytes.as_slice()).map_err(|e| AppError::Internal(format!("decode {method}: {e}"))),
        Err(RpcError::Application(e)) if e.code == "unauthorized" => Err(AppError::Unauthorized),
        Err(RpcError::Application(e)) => Err(AppError::Invalid(e.message)),
        Err(RpcError::Transport(msg)) => {
            log::write(Level::Warn, &format!("{method}: {msg}"));
            Err(AppError::Invalid("Could not reach the server. Please try again.".into()))
        }
        Err(RpcError::Host(e)) => Err(AppError::Internal(format!("{method}: {e:?}"))),
    }
}

fn reload() -> Result<(), AppError> {
    let list: TaskList = api("list_tasks", &Empty {})?;
    STATE.with(|s| s.borrow_mut().tasks = list.tasks);
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
                Body::Button(Button {
                    label: format!("Delete {}", t.title),
                    text: Some("Delete".into()),
                    emphasis: ButtonEmphasis::Plain,
                    disabled: false,
                    on_press: act("delete_task", &[("id", tid)]),
                }),
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
    STATE.with(|s| s.borrow_mut().rendered = tasks.iter().map(|n| n.id).collect());

    let mut nodes = vec![
        padded(ROOT, stack(Axis::Vertical, Token::Md), &[HEADER, MAIN, FOOTER]),
        node(HEADER, region(Landmark::Banner, "Site header"), &[TITLE]),
        node(TITLE, heading(1, "Lattice Tasks"), &[]),
        node(MAIN, region(Landmark::Main, "Task list"), &[FORM, SUMMARY, LIST]),
        node(FORM, Body::Form(Form { label: "Add a task".into(), on_submit: act("add_task", &[]) }), &[INPUT, ADD]),
        input_node(),
        node(
            ADD,
            Body::Button(Button {
                label: "Add task".into(),
                text: Some("Add".into()),
                emphasis: ButtonEmphasis::Primary,
                disabled: false,
                on_press: act("add_task", &[]),
            }),
            &[],
        ),
        summary_node(),
        list_node(&rows),
        node(FOOTER, region(Landmark::Contentinfo, "Site footer"), &[ABOUT_LINK]),
        node(ABOUT_LINK, link("/about", "About this app"), &[]),
    ];
    nodes.extend(tasks);
    Scene { title: "Lattice Tasks".into(), lang: Some("en".into()), live: Some(SUMMARY), root: ROOT, nodes }
}

fn about_scene() -> Scene {
    let nodes = vec![
        padded(1, stack(Axis::Vertical, Token::Md), &[2, 3]),
        node(2, region(Landmark::Main, "About"), &[4, 5, 6]),
        node(3, region(Landmark::Navigation, "Navigation"), &[7]),
        node(4, heading(1, "About"), &[]),
        node(5, text("Your tasks live on the server. This component asks for them over typed RPC and draws what it gets back."), &[]),
        node(6, text("Every request and response is validated against the API description before it crosses the boundary."), &[]),
        node(7, link("/", "Back to the task list"), &[]),
    ];
    Scene { title: "About".into(), lang: Some("en".into()), live: None, root: 1, nodes }
}

/// Replace the dynamic part of the scene: remove old task nodes, add the current ones, refresh the
/// list and summary.
fn refresh(focus: Option<NodeId>) -> Update {
    let (tasks, rows) = task_nodes();
    let old = STATE.with(|s| std::mem::replace(&mut s.borrow_mut().rendered, tasks.iter().map(|n| n.id).collect()));
    let mut ops: Vec<PatchOp> = old.into_iter().map(PatchOp::RemoveNode).collect();
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

struct TasksApp;

impl Guest for TasksApp {
    fn init(launch: Launch) -> Result<(), AppError> {
        log::write(Level::Info, &format!("tasks starting for {} ({})", launch.origin, launch.locale));
        Ok(())
    }

    fn route(request: RouteRequest) -> Result<Scene, AppError> {
        match request.handler.as_str() {
            "Home" => {
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
                Ok(refresh(None))
            }
            "delete_task" => {
                let id = arg_int(&call, "id").ok_or_else(|| AppError::Invalid("missing id".into()))?;
                let _: Nothing = api("delete_task", &DeleteTask { id })?;
                STATE.with(|s| s.borrow_mut().tasks.retain(|t| t.id != id));
                Ok(refresh(Some(INPUT)))
            }
            other => {
                log::write(Level::Warn, &format!("unknown action {other}"));
                Err(AppError::Invalid(format!("unknown action {other}")))
            }
        }
    }

    fn on_event(_event: HostEvent) -> Result<Update, AppError> {
        Ok(Update { ops: vec![], focus: None })
    }
}

export!(TasksApp);
