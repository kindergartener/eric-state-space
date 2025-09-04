use std::path::PathBuf;

use anyhow::{Context, Result};
use fnv::FnvHashMap as Map;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Clone, Serialize)]
struct Node {
    id: usize,
    label: String,
    count: usize,
    x: f32,
    y: f32,
}

#[derive(Clone, Serialize)]
struct Edge {
    source: usize,
    target: usize,
    weight: usize,
}

#[derive(Serialize)]
struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

const WIDTH: f32 = 1200.0;
const HEIGHT: f32 = 800.0;
const MAX_NODES: usize = 30;
const WINDOW: usize = 12;

fn main() -> Result<()> {
    let root = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "content/blog".into());
    let outdir = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "static/graph".into());
    fs::create_dir_all(&outdir)?;

    let posts = collect_markdown(&root);
    let texts: Vec<String> = posts?
        .iter()
        .map(|p| md_to_text(p).unwrap_or_default())
        .collect();

    let stop = stopwords();
    let reg_word = Regex::new(r"[A-Za-z0-9][A-Za-z0-9\-']+").unwrap();

    // tokenization + extract bigrams
    let docs: Vec<Vec<String>> = texts
        .iter()
        .map(|txt| tokenize(&reg_word, txt, &stop))
        .collect();

    // token frequency
    let mut freq: Map<String, usize> = Map::default();
    for doc in &docs {
        for word in doc {
            *freq.entry(word.clone()).or_default() += 1;
        }
    }

    // keep top MAX_NODES by frequency
    let mut vocab: Vec<(String, usize)> = freq.into_iter().collect();
    vocab.sort_by(|a, b| b.1.cmp(&a.1));
    vocab.truncate(MAX_NODES);
    let vocab_set: Map<String, usize> = vocab
        .iter()
        .enumerate()
        .map(|(i, (w, _))| (w.clone(), i))
        .collect();

    // co-occurrence counts
    let mut co: Map<(usize, usize), usize> = Map::default();
    let mut counts: Vec<usize> = vec![0; vocab_set.len()];

    for doc in &docs {
        let idxs: Vec<usize> = doc
            .iter()
            .filter_map(|w| vocab_set.get(w).copied())
            .collect();
        for (i, &a) in idxs.iter().enumerate() {
            counts[a] += 1;
            let end = (i + WINDOW).min(idxs.len());
            for &b in &idxs[i + 1..end] {
                let (u, v) = if a < b { (a, b) } else { (b, a) };
                *co.entry((u, v)).or_default() += 1;
            }
        }
    }

    // build graph
    let mut nodes: Vec<Node> = vec![];
    for (label, _) in &vocab {
        nodes.push(Node {
            id: nodes.len(),
            label: label.clone(),
            count: 0,
            x: 0.0,
            y: 0.0,
        });
    }
    for (i, c) in counts.into_iter().enumerate() {
        nodes[i].count = c;
    }

    let mut edges: Vec<Edge> = co
        .into_iter()
        .map(|((u, v), w)| Edge {
            source: u,
            target: v,
            weight: w,
        })
        .collect();

    // prune weak edges
    edges.retain(|e| e.weight > 1);
    edges.sort_by(|a, b| b.weight.cmp(&a.weight));
    edges.truncate(MAX_NODES * 6);

    // layout (Fruchterman-Reingold)
    layout_fr(&mut nodes, &edges, WIDTH, HEIGHT);

    let graph = Graph {
        nodes: nodes.clone(),
        edges: edges.clone(),
    };
    let json_path = Path::new(&outdir).join("graph.json");
    fs::write(&json_path, serde_json::to_vec_pretty(&graph)?)?;

    // render SVG
    let svg_path = Path::new(&outdir).join("graph.svg");
    fs::write(&svg_path, render_svg(&nodes, &edges, WIDTH, HEIGHT))?;

    println!("Wrote {}", svg_path.display());
    println!("Wrote {}", json_path.display());

    Ok(())
}

fn collect_markdown(dir: &str) -> Result<Vec<PathBuf>> {
    let mut files = vec![];
    for e in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        let p = e.path();
        if p.is_file() && p.extension().map(|x| x == "md").unwrap_or(false) {
            files.push(p.to_path_buf());
        }
    }
    Ok(files)
}

fn md_to_text(p: &Path) -> Result<String> {
    let s = fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?;

    // strip frontmatter
    let body = if s.starts_with("+++") {
        if let Some(end) = s.find("\n+++\n") {
            s[end + 5..].to_string()
        } else {
            s
        }
    } else {
        s
    };

    let parser = Parser::new_ext(&body, Options::ENABLE_FOOTNOTES | Options::ENABLE_TABLES);
    let mut out = String::new();
    let mut in_code = false;
    for ev in parser {
        match ev {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
            }
            Event::Text(t) if !in_code => {
                out.push_str(&t);
                out.push(' ');
            }
            _ => {}
        }
    }

    Ok(out)
}

fn tokenize(reg: &Regex, text: &str, stop: &std::collections::HashSet<String>) -> Vec<String> {
    let tokens: Vec<String> = reg
        .find_iter(&text.to_lowercase())
        .map(|m| m.as_str().trim_matches('-').to_string())
        .filter(|w| w.len() >= 3 && !stop.contains(w))
        .collect();

    // add bigrams
    let mut grams = Vec::with_capacity(tokens.len() * 2);
    for i in 0..tokens.len() {
        grams.push(tokens[i].clone());
        if i + 1 < tokens.len() {
            let bi = format!("{} {}", tokens[i], tokens[i + 1]);
            if !stop.contains(&tokens[i]) && !stop.contains(&tokens[i + 1]) {
                grams.push(bi);
            }
        }
    }

    grams
}

fn stopwords() -> std::collections::HashSet<String> {
    let list = [
        "the", "and", "for", "with", "that", "this", "you", "your", "from", "are", "but", "was",
        "were", "have", "has", "had", "not", "can", "will", "would", "could", "should", "about",
        "into", "out", "over", "under", "between", "within", "without", "after", "before", "when",
        "where", "how", "why", "what", "which", "while", "than", "then", "also", "just", "like",
        "some", "more", "most", "much", "many", "each", "other", "another", "been", "being", "use",
        "used", "using", "via", "a", "an", "in", "on", "of", "to", "as", "it", "is", "at", "by",
        "or", "if", "we", "i",
    ];

    list.iter().map(|s| s.to_string()).collect()
}

fn layout_fr(nodes: &mut [Node], edges: &[Edge], w: f32, h: f32) {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(37);
    let n = nodes.len() as f32;
    let area = w * h;
    let k = (area / n).sqrt().max(1.0);

    for v in nodes.iter_mut() {
        v.x = rng.random::<f32>() * w;
        v.y = rng.random::<f32>() * h;
    }

    let iterations = 400usize;
    let mut t = w.min(h) / 10.0;

    for _ in 0..iterations {
        let mut disp = vec![(0.0f32, 0.0f32); nodes.len()];

        // calculate repulsive forces
        for i in 0..nodes.len() {
            for j in i + 1..nodes.len() {
                let dx = nodes[i].x - nodes[j].x;
                let dy = nodes[i].y - nodes[j].y;
                let dist = (dx * dx + dy * dy).sqrt().max(0.01);
                let force = (k * k) / dist;
                let (fx, fy) = (dx / dist * force, dy / dist * force);
                disp[i].0 += fx;
                disp[i].1 += fy;
                disp[j].0 -= fx;
                disp[j].1 -= fy;
            }
        }

        // calculate attractive forces
        for e in edges {
            let (i, j) = (e.source, e.target);
            let dx = nodes[i].x - nodes[j].x;
            let dy = nodes[i].y - nodes[j].y;
            let dist = (dx * dx + dy * dy).sqrt().max(0.01);
            let force = (k * k) / dist;
            let (fx, fy) = (dx / dist * force, dy / dist * force);
            disp[i].0 -= fx;
            disp[i].1 -= fy;
            disp[j].0 += fx;
            disp[j].1 += fy;
        }

        // limit max displacement by temperature
        for (i, v) in nodes.iter_mut().enumerate() {
            let (mut dx, mut dy) = disp[i];
            let disp_len = (dx * dx + dy * dy).sqrt().max(0.01);
            dx = dx / disp_len * dx.abs().min(t);
            dy = dy / disp_len * dy.abs().min(t);

            v.x = (v.x + dx).clamp(0.0, w);
            v.y = (v.y + dy).clamp(0.0, h);
        }

        t *= 0.96;
        if t < 0.5 {
            break;
        }
    }
}

fn render_svg(nodes: &[Node], edges: &[Edge], w: f32, h: f32) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        r#"<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">
<style>
text {{ font: 12px system-ui, sans-serif; fill: #222; }}
.line {{ stroke: #999; stroke-opacity: .6; }}
.node {{ fill: #3b82f6; }}
</style>
<rect x="0" y="0" width="{w}" height="{h}" fill="white" />
"#
    ));

    for e in edges {
        let (a, b) = (&nodes[e.source], &nodes[e.target]);
        let sw = (1.0 + (e.weight as f32).ln()).clamp(1.0, 6.0);
        s.push_str(&format!(
            r#"<line class="line" x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}" stroke-width="{:.2}" />"#,
            a.x, a.y, b.x, b.y, sw
        ));
    }

    for n in nodes {
        let r = 4.0 + (n.count as f32).log2().max(0.0);
        s.push_str(&format!(
            r#"<circle class="node" cx="{:.1}" cy="{:.1}" r="{:.1}"/>"#,
            n.x, n.y, r
        ));
        s.push_str(&format!(
            r#"<text x="{:.1}" y="{:.1}" dx="6" dy="4">{}</text>"#,
            n.x,
            n.y,
            xml_esc(&n.label)
        ));
    }

    s.push_str("</svg>");

    s
}

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
