//! Lattice reference app: a shared grid whose players move live.
//!
//! The component never polls. It joins over RPC, subscribes to the `world` topic, and redraws whenever the host
//! delivers a message. Each message is the whole picture, so a message that was dropped is repaired by the next.
//! The fireflies topic is sent as unreliable datagrams, many times a second; the app does not know or care.

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

const ROOT: NodeId = 1;
const HEADER: NodeId = 2;
const TITLE: NodeId = 3;
const MAIN: NodeId = 4;
const STATUS: NodeId = 5;
const PAD: NodeId = 7;
const UP: NodeId = 8;
const DOWN: NodeId = 9;
const LEFT: NodeId = 10;
const RIGHT: NodeId = 11;

#[derive(Clone, Deserialize)]
struct Player {
    id: u32,
    name: String,
    x: u32,
    y: u32,
}

#[derive(Deserialize)]
struct Picture {
    players: Vec<Player>,
}

#[derive(Clone, Deserialize)]
struct Fly {
    x: u32,
    y: u32,
}

#[derive(Deserialize)]
struct Swarm {
    flies: Vec<Fly>,
}

#[derive(Deserialize)]
struct Joined {
    id: u32,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
struct Step {
    dx: i32,
    dy: i32,
}

#[derive(Default)]
struct State {
    me: u32,
    width: u32,
    height: u32,
    players: Vec<Player>,
    flies: Vec<Fly>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn api<Req: Serialize, Res: DeserializeOwned>(method: &str, req: &Req) -> Result<Res, AppError> {
    let mut body = Vec::new();
    ciborium::into_writer(req, &mut body).map_err(|e| AppError::Internal(format!("encode {method}: {e}")))?;
    match rpc::call(method, &body) {
        Ok(bytes) => ciborium::from_reader(bytes.as_slice()).map_err(|e| AppError::Internal(format!("decode {method}: {e}"))),
        Err(RpcError::Application(e)) => Err(AppError::Invalid(e.message)),
        Err(RpcError::Transport(msg)) => {
            log::write(Level::Warn, &format!("{method}: {msg}"));
            Err(AppError::Invalid("Could not reach the server. Please try again.".into()))
        }
        Err(RpcError::Host(e)) => Err(AppError::Internal(format!("{method}: {e:?}"))),
    }
}

fn common() -> Common {
    Common { hidden: false, width: None, height: None, padding: None, tone: None, label: None, description: None, lang: None }
}

fn node(id: NodeId, body: Body, children: &[NodeId]) -> Node {
    Node { id, common: common(), body, children: children.to_vec() }
}

fn text(s: &str) -> Body {
    Body::Text(Text { text: s.to_string(), style: TextStyle::Body, emphasis: TextEmphasis::None, max_lines: None, selectable: false })
}

fn step_button(id: NodeId, label: &str, glyph: &str, dx: i32, dy: i32) -> Node {
    let action = ActionRef { action: "move".into(), args: vec![("dx".into(), Scalar::Integer(dx as i64)), ("dy".into(), Scalar::Integer(dy as i64))] };
    node(id, Body::Button(Button { label: label.into(), text: Some(glyph.into()), emphasis: ButtonEmphasis::Secondary, disabled: false, on_press: action }), &[])
}

const CELL: f32 = 40.0;
const CANVAS: NodeId = 6;

/// The picture: a faint grid, then everyone standing on it. You are the accent colour; the others are green, each
/// marked with the first letter of their name. The host decides what the tones look like.
fn drawing() -> Drawing {
    STATE.with(|s| {
        let s = s.borrow();
        let (w, h) = (s.width as f32 * CELL, s.height as f32 * CELL);
        let mut ops = Vec::new();
        for x in 0..=s.width {
            let px = x as f32 * CELL;
            ops.push(DrawOp::Line(DrawLine { x1: px, y1: 0.0, x2: px, y2: h, tone: Tone::Muted, width: 0.5 }));
        }
        for y in 0..=s.height {
            let py = y as f32 * CELL;
            ops.push(DrawOp::Line(DrawLine { x1: 0.0, y1: py, x2: w, y2: py, tone: Tone::Muted, width: 0.5 }));
        }
        for f in &s.flies {
            // Hundredths of a cell. Drawn under the players, small and warm.
            ops.push(DrawOp::Ellipse(DrawEllipse { cx: f.x as f32 / 100.0 * CELL, cy: f.y as f32 / 100.0 * CELL, rx: CELL * 0.07, ry: CELL * 0.07, tone: Tone::Caution, outline: false }));
        }
        for p in &s.players {
            let (cx, cy) = ((p.x as f32 + 0.5) * CELL, (p.y as f32 + 0.5) * CELL);
            let me = p.id == s.me;
            let tone = if me { Tone::Accent } else { Tone::Positive };
            ops.push(DrawOp::Ellipse(DrawEllipse { cx, cy, rx: CELL * 0.38, ry: CELL * 0.38, tone, outline: false }));
            if me {
                ops.push(DrawOp::Ellipse(DrawEllipse { cx, cy, rx: CELL * 0.46, ry: CELL * 0.46, tone: Tone::Accent, outline: true }));
            }
            let initial = p.name.chars().next().unwrap_or('?').to_string();
            ops.push(DrawOp::Text(DrawText { x: cx, y: cy, text: initial, size: CELL * 0.4, tone: Tone::Default }));
        }
        Drawing { width: s.width * CELL as u32, height: s.height * CELL as u32, ops }
    })
}

fn canvas_node() -> Node {
    let who: Vec<String> = STATE.with(|s| s.borrow().players.iter().map(|p| format!("{} at column {}, row {}", p.name, p.x + 1, p.y + 1)).collect());
    let description = format!("A grid you share with everyone online. Use the arrow keys, or click a square, to step. {}.", who.join("; "));
    node(
        CANVAS,
        Body::Canvas(Canvas {
            label: "The world".into(),
            description,
            surface: None,
            drawing: Some(drawing()),
            on_input: Some(ActionRef { action: "input".into(), args: vec![] }),
        }),
        &[],
    )
}

fn status_text() -> String {
    STATE.with(|s| {
        let s = s.borrow();
        let n = s.players.len();
        match s.players.iter().find(|p| p.id == s.me) {
            Some(p) => format!("{} online. You are {} at column {}, row {}.", n, p.name, p.x + 1, p.y + 1),
            None => format!("{} online.", n),
        }
    })
}

fn world_scene() -> Scene {
    let nodes = vec![
        node(ROOT, Body::Stack(Stack { axis: Axis::Vertical, gap: Token::Md, align: Align::Stretch, justify: Justify::Start, wrap: false }), &[HEADER, MAIN]),
        node(HEADER, Body::Region(Region { role: Landmark::Banner, label: "Site header".into() }), &[TITLE]),
        node(TITLE, Body::Heading(Heading { level: 1, text: "Lattice World".into() }), &[]),
        node(MAIN, Body::Region(Region { role: Landmark::Main, label: "The world".into() }), &[STATUS, CANVAS, PAD]),
        node(STATUS, text(&status_text()), &[]),
        canvas_node(),
        node(PAD, Body::Stack(Stack { axis: Axis::Horizontal, gap: Token::Sm, align: Align::Center, justify: Justify::Start, wrap: true }), &[LEFT, UP, DOWN, RIGHT]),
        step_button(LEFT, "Move left", "←", -1, 0),
        step_button(UP, "Move up", "↑", 0, -1),
        step_button(DOWN, "Move down", "↓", 0, 1),
        step_button(RIGHT, "Move right", "→", 1, 0),
    ];
    Scene { title: "Lattice World".into(), lang: Some("en".into()), live: Some(STATUS), root: ROOT, nodes }
}

fn redraw() -> Update {
    Update { ops: vec![PatchOp::SetNode(canvas_node()), PatchOp::SetNode(node(STATUS, text(&status_text()), &[]))], focus: None }
}

/// Where a click or key asks to go, as a step: arrows are one square; a click steps toward that square.
fn step_for(call: &ActionCall) -> Option<(i32, i32)> {
    let text = |name: &str| call.values.iter().find_map(|(k, v)| match v { Scalar::Text(t) if k == name => Some(t.clone()), _ => None });
    let num = |name: &str| call.values.iter().find_map(|(k, v)| match v { Scalar::Number(f) if k == name => Some(*f), Scalar::Integer(i) if k == name => Some(*i as f64), _ => None });
    match text("kind")?.as_str() {
        "key" => match text("key")?.as_str() {
            "ArrowUp" => Some((0, -1)),
            "ArrowDown" => Some((0, 1)),
            "ArrowLeft" => Some((-1, 0)),
            "ArrowRight" => Some((1, 0)),
            _ => None,
        },
        "pointer" => {
            let (cx, cy) = ((num("x")? / CELL as f64).floor() as i32, (num("y")? / CELL as f64).floor() as i32);
            STATE.with(|s| {
                let s = s.borrow();
                let me = s.players.iter().find(|p| p.id == s.me)?;
                let (dx, dy) = (cx - me.x as i32, cy - me.y as i32);
                // One step along the longer axis, so a click across the board walks there a step at a time.
                if dx == 0 && dy == 0 { None } else if dx.abs() >= dy.abs() { Some((dx.signum(), 0)) } else { Some((0, dy.signum())) }
            })
        }
        _ => None,
    }
}

struct WorldApp;

impl Guest for WorldApp {
    fn init(launch: Launch) -> Result<(), AppError> {
        log::write(Level::Info, &format!("world starting for {}", launch.origin));
        Ok(())
    }

    fn route(request: RouteRequest) -> Result<Scene, AppError> {
        if request.handler != "Home" {
            return Err(AppError::NotFound);
        }
        let joined: Joined = api("join", &Empty {})?;
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.me = joined.id;
            s.width = joined.width;
            s.height = joined.height;
        });
        // The first message on the topic is the current picture, so it arrives straight after this returns.
        rpc::subscribe("world").map_err(|e| AppError::Internal(format!("subscribe: {e:?}")))?;
        rpc::subscribe("fireflies").map_err(|e| AppError::Internal(format!("subscribe: {e:?}")))?;
        Ok(world_scene())
    }

    fn dispatch(call: ActionCall) -> Result<Update, AppError> {
        let (dx, dy) = match call.action.as_str() {
            "move" => {
                let get = |name: &str| {
                    call.args.iter().find_map(|(k, v)| match v {
                        Scalar::Integer(i) if k == name => Some(*i as i32),
                        _ => None,
                    })
                };
                (get("dx").unwrap_or(0), get("dy").unwrap_or(0))
            }
            "input" => match step_for(&call) {
                Some(step) => step,
                None => return Ok(Update { ops: vec![], focus: None }),
            },
            other => return Err(AppError::Invalid(format!("unknown action {other}"))),
        };
        let _: serde::de::IgnoredAny = api("move", &Step { dx, dy })?;
        // The new position arrives on the topic, like everyone else's: nothing is drawn from the reply.
        Ok(Update { ops: vec![], focus: None })
    }

    fn on_event(event: HostEvent) -> Result<Update, AppError> {
        match event {
            HostEvent::StreamMessage(m) if m.topic == "world" => {
                let picture: Picture = ciborium::from_reader(m.payload.as_slice()).map_err(|e| AppError::Internal(format!("decode world: {e}")))?;
                STATE.with(|s| s.borrow_mut().players = picture.players);
                Ok(redraw())
            }
            HostEvent::StreamMessage(m) if m.topic == "fireflies" => {
                let swarm: Swarm = ciborium::from_reader(m.payload.as_slice()).map_err(|e| AppError::Internal(format!("decode fireflies: {e}")))?;
                STATE.with(|s| s.borrow_mut().flies = swarm.flies);
                // Only the picture: the status line and the description have not changed.
                Ok(Update { ops: vec![PatchOp::SetNode(canvas_node())], focus: None })
            }
            _ => Ok(Update { ops: vec![], focus: None }),
        }
    }
}

export!(WorldApp);
