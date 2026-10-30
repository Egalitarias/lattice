//! Lattice reference app: a todo list.
//!
//! Demonstrates the component model contract: state lives here, the UI is returned as a scene
//! arena, user actions arrive through `dispatch`, and persistence uses the `storage` capability.

wit_bindgen::generate!({
    path: "../../spec/wit",
    world: "app",
});

use std::cell::RefCell;

use exports::lattice::app::lifecycle::{ActionCall, Guest, HostEvent, Launch, RouteRequest};
use lattice::app::log::{self, Level};
use lattice::app::scene::*;
use lattice::app::storage;
use lattice::app::types::{AppError, Scalar};

const STORAGE_KEY: &str = "todos";

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
// Todo `n` occupies ids ROW_BASE + n*4 .. +2 (row, checkbox, delete button).
const ROW_BASE: NodeId = 1000;

struct Todo {
    id: u32,
    text: String,
    done: bool,
}

#[derive(Default)]
struct State {
    todos: Vec<Todo>,
    next_id: u32,
    /// Ids of the todo nodes currently in the host's scene, so the next update can remove them.
    rendered: Vec<NodeId>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

// ---- Scene helpers ----------------------------------------------------------------------------

fn common() -> Common {
    Common {
        hidden: false,
        width: None,
        height: None,
        padding: None,
        tone: None,
        label: None,
        description: None,
        lang: None,
    }
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
    ActionRef {
        action: name.to_string(),
        args: args.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
    }
}

fn stack(axis: Axis, gap: Token) -> Body {
    Body::Stack(Stack { axis, gap, align: Align::Stretch, justify: Justify::Start, wrap: false })
}

fn text(s: &str) -> Body {
    Body::Text(Text {
        text: s.to_string(),
        style: TextStyle::Body,
        emphasis: TextEmphasis::None,
        max_lines: None,
        selectable: true,
    })
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

fn summary_text() -> String {
    STATE.with(|s| {
        let s = s.borrow();
        let done = s.todos.iter().filter(|t| t.done).count();
        let n = s.todos.len();
        format!("{} item{}, {} done", n, if n == 1 { "" } else { "s" }, done)
    })
}

/// Nodes for every todo row, plus the row ids (the list's children).
fn todo_nodes() -> (Vec<Node>, Vec<NodeId>) {
    STATE.with(|s| {
        let s = s.borrow();
        let mut nodes = Vec::new();
        let mut rows = Vec::new();
        for t in &s.todos {
            let row = ROW_BASE + t.id * 4;
            let (check, del) = (row + 1, row + 2);
            let tid = Scalar::Integer(t.id as i64);
            nodes.push(node(row, stack(Axis::Horizontal, Token::Sm), &[check, del]));
            nodes.push(node(
                check,
                Body::Checkbox(Checkbox {
                    name: format!("done_{}", t.id),
                    label: t.text.clone(),
                    checked: t.done,
                    on_change: Some(act("toggle_todo", &[("id", tid.clone())])),
                }),
                &[],
            ));
            nodes.push(node(
                del,
                Body::Button(Button {
                    label: format!("Delete {}", t.text),
                    text: Some("Delete".into()),
                    emphasis: ButtonEmphasis::Plain,
                    disabled: false,
                    on_press: act("delete_todo", &[("id", tid)]),
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

fn summary_node() -> Node {
    node(SUMMARY, text(&summary_text()), &[])
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
    let (todos, rows) = todo_nodes();
    STATE.with(|s| s.borrow_mut().rendered = todos.iter().map(|n| n.id).collect());

    let mut nodes = vec![
        padded(ROOT, stack(Axis::Vertical, Token::Md), &[HEADER, MAIN, FOOTER]),
        node(HEADER, region(Landmark::Banner, "Site header"), &[TITLE]),
        node(TITLE, heading(1, "Lattice Todo"), &[]),
        node(MAIN, region(Landmark::Main, "Todo list"), &[FORM, SUMMARY, LIST]),
        node(
            FORM,
            Body::Form(Form { label: "Add a todo".into(), on_submit: act("add_todo", &[]) }),
            &[INPUT, ADD],
        ),
        input_node(),
        node(
            ADD,
            Body::Button(Button {
                label: "Add todo".into(),
                text: Some("Add".into()),
                emphasis: ButtonEmphasis::Primary,
                disabled: false,
                on_press: act("add_todo", &[]),
            }),
            &[],
        ),
        summary_node(),
        list_node(&rows),
        node(FOOTER, region(Landmark::Contentinfo, "Site footer"), &[ABOUT_LINK]),
        node(ABOUT_LINK, link("/about", "About this app"), &[]),
    ];
    nodes.extend(todos);

    Scene { title: "Lattice Todo".into(), lang: Some("en".into()), live: Some(SUMMARY), root: ROOT, nodes }
}

fn about_scene() -> Scene {
    let nodes = vec![
        padded(1, stack(Axis::Vertical, Token::Md), &[2, 3]),
        node(2, region(Landmark::Main, "About"), &[4, 5, 6]),
        node(3, region(Landmark::Navigation, "Navigation"), &[7]),
        node(4, heading(1, "About"), &[]),
        node(
            5,
            text("This page is not HTML, CSS or JavaScript. It is a scene tree returned by a WASM component and drawn by Lattice Navigator."),
            &[],
        ),
        node(6, text("State lives inside the component. Persistence uses the storage capability."), &[]),
        node(7, link("/", "Back to the todo list"), &[]),
    ];
    Scene { title: "About".into(), lang: Some("en".into()), live: None, root: 1, nodes }
}

// ---- Persistence ------------------------------------------------------------------------------

fn save() {
    let data = STATE.with(|s| {
        s.borrow()
            .todos
            .iter()
            .map(|t| format!("{}|{}|{}", t.id, if t.done { 1 } else { 0 }, t.text.replace('\n', " ")))
            .collect::<Vec<_>>()
            .join("\n")
    });
    if let Err(e) = storage::set(STORAGE_KEY, data.as_bytes()) {
        log::write(Level::Warn, &format!("could not save todos: {e:?}"));
    }
}

fn load() {
    let Ok(Some(bytes)) = storage::get(STORAGE_KEY) else { return };
    let Ok(text) = String::from_utf8(bytes) else { return };
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        for line in text.lines() {
            let mut parts = line.splitn(3, '|');
            let (Some(id), Some(done), Some(t)) = (parts.next(), parts.next(), parts.next()) else { continue };
            let Ok(id) = id.parse::<u32>() else { continue };
            s.todos.push(Todo { id, text: t.to_string(), done: done == "1" });
            s.next_id = s.next_id.max(id + 1);
        }
    });
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

/// Replace the dynamic part of the scene: remove old todo nodes, add the current ones, then
/// refresh the list and the summary.
fn refresh(focus: Option<NodeId>) -> Update {
    let (todos, rows) = todo_nodes();
    let old = STATE.with(|s| std::mem::replace(&mut s.borrow_mut().rendered, todos.iter().map(|n| n.id).collect()));

    let mut ops: Vec<PatchOp> = old.into_iter().map(PatchOp::RemoveNode).collect();
    ops.extend(todos.into_iter().map(PatchOp::SetNode));
    ops.push(PatchOp::SetNode(list_node(&rows)));
    ops.push(PatchOp::SetNode(summary_node()));
    Update { ops, focus }
}

struct TodoApp;

impl Guest for TodoApp {
    fn init(launch: Launch) -> Result<(), AppError> {
        log::write(Level::Info, &format!("todo starting for {} ({})", launch.origin, launch.locale));
        load();
        Ok(())
    }

    fn route(request: RouteRequest) -> Result<Scene, AppError> {
        match request.handler.as_str() {
            "Home" => Ok(home_scene()),
            "About" => Ok(about_scene()),
            _ => Err(AppError::NotFound),
        }
    }

    fn dispatch(call: ActionCall) -> Result<Update, AppError> {
        match call.action.as_str() {
            "add_todo" => {
                let title = value_text(&call, "title").unwrap_or_default();
                let title = title.trim();
                if title.is_empty() {
                    return Err(AppError::Invalid("Enter something to do first.".into()));
                }
                STATE.with(|s| {
                    let mut s = s.borrow_mut();
                    let id = s.next_id;
                    s.next_id += 1;
                    s.todos.push(Todo { id, text: title.to_string(), done: false });
                });
                save();
                let mut update = refresh(Some(INPUT));
                // Re-sending the input with an empty value clears the field.
                update.ops.push(PatchOp::SetNode(input_node()));
                Ok(update)
            }
            "toggle_todo" => {
                let id = arg_int(&call, "id").ok_or_else(|| AppError::Invalid("missing id".into()))?;
                let checked = value_bool(&call);
                STATE.with(|s| {
                    if let Some(t) = s.borrow_mut().todos.iter_mut().find(|t| t.id == id) {
                        t.done = checked.unwrap_or(!t.done);
                    }
                });
                save();
                Ok(refresh(None))
            }
            "delete_todo" => {
                let id = arg_int(&call, "id").ok_or_else(|| AppError::Invalid("missing id".into()))?;
                STATE.with(|s| s.borrow_mut().todos.retain(|t| t.id != id));
                save();
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

export!(TodoApp);
