//! Lattice reference app: a plasma the app paints itself.
//!
//! The component owns a surface. Each time the host says a frame is wanted it paints the next picture into its own memory
//! and hands it over; the host puts it on screen. Click or press a key on the picture to ripple it. Nothing here touches a
//! display, a clock the host did not give, or the network.

wit_bindgen::generate!({
    path: "../../spec/wit",
    world: "app",
});

use std::cell::{Cell, RefCell};

use exports::lattice::app::lifecycle::{ActionCall, Guest, HostEvent, Launch, RouteRequest};
use lattice::app::log::{self, Level};
use lattice::app::scene::*;
use lattice::app::surface;
use lattice::app::types::{AppError, Scalar};

const W: u32 = 160;
const H: u32 = 100;

const ROOT: NodeId = 1;
const HEADER: NodeId = 2;
const TITLE: NodeId = 3;
const MAIN: NodeId = 4;
const NOTE: NodeId = 5;
const CANVAS: NodeId = 6;

#[derive(Default)]
struct State {
    handle: String,
    /// x, y (in surface pixels) and the time the ripple started, in seconds.
    ripples: Vec<(f32, f32, f32)>,
    pixels: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
    /// The time of the latest frame, so a ripple starts when the user clicked rather than at the next frame.
    static NOW: Cell<f32> = const { Cell::new(0.0) };
}

fn common() -> Common {
    Common { hidden: false, width: None, height: None, padding: None, tone: None, label: None, description: None, lang: None }
}

fn node(id: NodeId, body: Body, children: &[NodeId]) -> Node {
    Node { id, common: common(), body, children: children.to_vec() }
}

fn canvas_node(handle: &str) -> Node {
    node(
        CANVAS,
        Body::Canvas(Canvas {
            label: "Plasma".into(),
            description: "A slowly shifting pattern of colour that the app paints. Click it, or press a key while it is focused, to start a ripple.".into(),
            surface: Some(handle.to_string()),
            drawing: None,
            on_input: Some(ActionRef { action: "input".into(), args: vec![] }),
        }),
        &[],
    )
}

/// A colour from a value in 0..1, going round a smooth palette.
fn palette(v: f32) -> [u8; 3] {
    let t = v * std::f32::consts::TAU;
    let c = |phase: f32| ((0.5 + 0.5 * (t + phase).sin()) * 255.0) as u8;
    [c(0.0), c(2.1), c(4.2)]
}

/// Paint the whole picture for time `t` (seconds): sine fields summed per pixel, plus any ripples.
fn paint(t: f32) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let State { ripples, pixels, .. } = &mut *s;
        ripples.retain(|r| t - r.2 < 3.0);
        for y in 0..H {
            for x in 0..W {
                let (fx, fy) = (x as f32, y as f32);
                let mut v = (fx * 0.08 + t * 1.1).sin() + (fy * 0.11 - t * 0.8).sin() + ((fx + fy) * 0.05 + t * 0.6).sin() + ((fx - 80.0).hypot(fy - 50.0) * 0.1 - t).sin();
                for &(rx, ry, t0) in ripples.iter() {
                    let age = t - t0;
                    let d = (fx - rx).hypot(fy - ry);
                    // A ring that spreads and fades.
                    v += 2.0 * (-(d - age * 40.0).powi(2) * 0.02).exp() * (1.0 - age / 3.0);
                }
                let [r, g, b] = palette(v * 0.125 + 0.5);
                let i = ((y * W + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
    })
}

fn present() -> Result<(), String> {
    STATE.with(|s| {
        let s = s.borrow();
        surface::present(&s.handle, &s.pixels).map_err(|e| format!("{e:?}"))
    })
}

fn scene(handle: &str) -> Scene {
    let nodes = vec![
        node(ROOT, Body::Stack(Stack { axis: Axis::Vertical, gap: Token::Md, align: Align::Stretch, justify: Justify::Start, wrap: false }), &[HEADER, MAIN]),
        node(HEADER, Body::Region(Region { role: Landmark::Banner, label: "Site header".into() }), &[TITLE]),
        node(TITLE, Body::Heading(Heading { level: 1, text: "Lattice Plasma".into() }), &[]),
        node(MAIN, Body::Region(Region { role: Landmark::Main, label: "The plasma".into() }), &[NOTE, CANVAS]),
        node(NOTE, Body::Text(Text { text: "Painted by the app, pixel by pixel, 160 by 100.".into(), style: TextStyle::Body, emphasis: TextEmphasis::None, max_lines: None, selectable: false }), &[]),
        canvas_node(handle),
    ];
    Scene { title: "Lattice Plasma".into(), lang: Some("en".into()), live: None, root: ROOT, nodes }
}

struct PlasmaApp;

impl Guest for PlasmaApp {
    fn init(launch: Launch) -> Result<(), AppError> {
        log::write(Level::Info, &format!("plasma starting for {}", launch.origin));
        Ok(())
    }

    fn route(request: RouteRequest) -> Result<Scene, AppError> {
        if request.handler != "Home" {
            return Err(AppError::NotFound);
        }
        let handle = surface::create(W, H).map_err(|e| AppError::Internal(format!("surface: {e:?}")))?;
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.handle = handle.clone();
            s.pixels = vec![0; (W * H * 4) as usize];
        });
        // The first picture, so the canvas is not empty before the host asks for a frame.
        paint(0.0);
        present().map_err(|e| AppError::Internal(format!("present: {e}")))?;
        Ok(scene(&handle))
    }

    fn dispatch(call: ActionCall) -> Result<Update, AppError> {
        if call.action != "input" {
            return Err(AppError::Invalid(format!("unknown action {}", call.action)));
        }
        let num = |name: &str| {
            call.values.iter().find_map(|(k, v)| match v {
                Scalar::Number(f) if k == name => Some(*f as f32),
                Scalar::Integer(i) if k == name => Some(*i as f32),
                _ => None,
            })
        };
        // A click ripples from where it landed (in surface pixels); a key ripples from the middle.
        let (x, y) = (num("x").unwrap_or(W as f32 / 2.0), num("y").unwrap_or(H as f32 / 2.0));
        let now = NOW.with(|t| t.get());
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.ripples.len() < 8 {
                s.ripples.push((x, y, now));
            }
        });
        Ok(Update { ops: vec![], focus: None })
    }

    fn on_event(event: HostEvent) -> Result<Update, AppError> {
        if let HostEvent::Frame(ms) = event {
            let t = (ms / 1000.0) as f32;
            NOW.with(|n| n.set(t));
            paint(t);
            // The host may be showing frames slower than this; a frame it refuses is simply not shown.
            let _ = present();
        }
        Ok(Update { ops: vec![], focus: None })
    }
}

export!(PlasmaApp);
