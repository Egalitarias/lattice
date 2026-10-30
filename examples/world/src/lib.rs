//! Lattice reference app: a shared grid whose players move live.
//!
//! The component never polls. It joins over RPC, subscribes to the `world` topic, and redraws whenever the host
//! delivers a message. Each message is the whole picture, so a message that was dropped is repaired by the next.

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
const MAP: NodeId = 6;
const PAD: NodeId = 7;
const UP: NodeId = 8;
const DOWN: NodeId = 9;
const LEFT: NodeId = 10;
const RIGHT: NodeId = 11;
const CELL_BASE: NodeId = 1000;

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

/// One cell per grid square: the first letter of whoever stands there ("@" for you), otherwise a dot.
fn cells() -> Vec<Node> {
    STATE.with(|s| {
        let s = s.borrow();
        let mut out = Vec::new();
        for y in 0..s.height {
            for x in 0..s.width {
                let here = s.players.iter().find(|p| p.x == x && p.y == y);
                let glyph = match here {
                    Some(p) if p.id == s.me => "@".to_string(),
                    Some(p) => p.name.chars().next().unwrap_or('?').to_string(),
                    None => "·".to_string(),
                };
                out.push(node(CELL_BASE + y * s.width + x, text(&glyph), &[]));
            }
        }
        out
    })
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
    let cell_ids: Vec<NodeId> = cells().iter().map(|n| n.id).collect();
    let width = STATE.with(|s| s.borrow().width) as u8;
    let mut nodes = vec![
        node(ROOT, Body::Stack(Stack { axis: Axis::Vertical, gap: Token::Md, align: Align::Stretch, justify: Justify::Start, wrap: false }), &[HEADER, MAIN]),
        node(HEADER, Body::Region(Region { role: Landmark::Banner, label: "Site header".into() }), &[TITLE]),
        node(TITLE, Body::Heading(Heading { level: 1, text: "Lattice World".into() }), &[]),
        node(MAIN, Body::Region(Region { role: Landmark::Main, label: "The world".into() }), &[STATUS, MAP, PAD]),
        node(STATUS, text(&status_text()), &[]),
        node(MAP, Body::Grid(Grid { columns: GridColumns::Fixed(width), gap: Token::Xs }), &cell_ids),
        node(PAD, Body::Stack(Stack { axis: Axis::Horizontal, gap: Token::Sm, align: Align::Center, justify: Justify::Start, wrap: true }), &[LEFT, UP, DOWN, RIGHT]),
        step_button(LEFT, "Move left", "←", -1, 0),
        step_button(UP, "Move up", "↑", 0, -1),
        step_button(DOWN, "Move down", "↓", 0, 1),
        step_button(RIGHT, "Move right", "→", 1, 0),
    ];
    nodes.extend(cells());
    Scene { title: "Lattice World".into(), lang: Some("en".into()), live: Some(STATUS), root: ROOT, nodes }
}

fn redraw() -> Update {
    let mut ops: Vec<PatchOp> = cells().into_iter().map(PatchOp::SetNode).collect();
    ops.push(PatchOp::SetNode(node(STATUS, text(&status_text()), &[])));
    Update { ops, focus: None }
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
        Ok(world_scene())
    }

    fn dispatch(call: ActionCall) -> Result<Update, AppError> {
        if call.action != "move" {
            return Err(AppError::Invalid(format!("unknown action {}", call.action)));
        }
        let get = |name: &str| {
            call.args.iter().find_map(|(k, v)| match v {
                Scalar::Integer(i) if k == name => Some(*i as i32),
                _ => None,
            })
        };
        let (dx, dy) = (get("dx").unwrap_or(0), get("dy").unwrap_or(0));
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
            _ => Ok(Update { ops: vec![], focus: None }),
        }
    }
}

export!(WorldApp);
