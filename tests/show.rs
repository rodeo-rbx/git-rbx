//! `git rbx show` (a file's instances with their properties) and
//! `diff --format json --with-properties` (the diff document plus each side's
//! properties, keyed by its manifest ids).
use git_rbx::show::{diff_with_properties, render_text, show, ShownInstance};
use git_rbx::{DiffConfig, DiffDom, DocumentOp, ManifestNode, PropertyValue};
use rbx_dom_weak::{InstanceBuilder, WeakDom};
use rbx_types::{CFrame, Matrix3, Variant, Vector3};

fn compact(dom: &WeakDom) -> DiffDom {
    // Through bytes, the way the CLI loads files.
    let mut bytes = Vec::new();
    rbx_binary::to_writer(&mut bytes, dom, dom.root().children()).unwrap();
    DiffDom::from_binary_reader(bytes.as_slice()).unwrap()
}

fn part(name: &str, transparency: f32) -> InstanceBuilder {
    InstanceBuilder::new("Part")
        .with_name(name)
        .with_property("Transparency", Variant::Float32(transparency))
}

fn folder(name: &str) -> InstanceBuilder {
    InstanceBuilder::new("Folder").with_name(name)
}

fn root(children: Vec<InstanceBuilder>) -> WeakDom {
    WeakDom::new(
        InstanceBuilder::new("Folder")
            .with_name("root")
            .with_children(children),
    )
}

fn node<'a>(manifest: &'a [ManifestNode], name: &str) -> &'a ManifestNode {
    manifest
        .iter()
        .find(|node| node.name == name)
        .unwrap_or_else(|| panic!("no instance named {name}"))
}

fn shown<'a>(instances: &'a [ShownInstance], name: &str) -> &'a ShownInstance {
    instances
        .iter()
        .find(|instance| instance.name == name)
        .unwrap_or_else(|| panic!("no instance named {name}"))
}

fn transparency(value: Option<&PropertyValue>) -> Option<f32> {
    match value {
        Some(PropertyValue::Float32 { value }) => Some(*value),
        _ => None,
    }
}

#[test]
fn properties_are_keyed_by_the_documents_manifest_ids() {
    let old = root(vec![folder("A").with_child(part("P", 0.25)).with_child(
        InstanceBuilder::new("Model")
            .with_name("Gone")
            .with_child(part("G", 0.25)),
    )]);
    let new = root(vec![
        folder("A").with_child(part("P", 0.5)),
        folder("Fresh").with_child(part("F", 0.75)),
    ]);
    let config = DiffConfig::default();
    let output = diff_with_properties(&compact(&old), &mut compact(&new), &config);
    let document = &output.document;

    let p = node(&document.new, "P").id;
    assert_eq!(
        node(&document.old, "P").id,
        p,
        "a matched instance keeps its id"
    );
    assert_eq!(
        transparency(output.properties.old[&p].get("Transparency")),
        Some(0.25)
    );
    assert_eq!(
        transparency(output.properties.new[&p].get("Transparency")),
        Some(0.5)
    );

    let gone = node(&document.old, "Gone").id;
    let fresh = node(&document.new, "Fresh").id;
    assert!(
        output.properties.old.contains_key(&gone) && !output.properties.new.contains_key(&gone)
    );
    assert!(
        output.properties.new.contains_key(&fresh) && !output.properties.old.contains_key(&fresh)
    );

    for op in &document.ops {
        match op {
            DocumentOp::SetProperty { id, property, .. } => {
                assert_eq!((*id, property.as_str()), (p, "Transparency"));
            }
            DocumentOp::Remove { id, .. } => assert_eq!(*id, gone),
            DocumentOp::Add { id, subtree, .. } => {
                assert_eq!(*id, fresh);
                // The document stays whole: an add still carries its subtree's
                // properties.
                let f = subtree.iter().find(|added| added.name == "F").unwrap();
                assert_eq!(transparency(f.properties.get("Transparency")), Some(0.75));
            }
            other => panic!("unexpected op {other:?}"),
        }
    }
}

#[test]
fn with_properties_leaves_the_document_as_diff_prints_it() {
    let old = root(vec![folder("A").with_child(part("P", 0.25))]);
    let new = root(vec![
        folder("A").with_child(part("P", 0.5)),
        folder("Fresh"),
    ]);
    let config = DiffConfig::default();
    let plain =
        git_rbx::diff_model_compact_doms_document(&compact(&old), &mut compact(&new), &config);
    let output = diff_with_properties(&compact(&old), &mut compact(&new), &config);

    let mut with = serde_json::to_value(&output).unwrap();
    let with = with.as_object_mut().unwrap();
    for extra in ["properties", "defaults", "content"] {
        assert!(with.remove(extra).is_some(), "{extra} is added");
    }
    assert_eq!(
        serde_json::Value::Object(with.clone()),
        serde_json::to_value(&plain).unwrap()
    );
}

#[test]
fn moved_into_an_added_subtree_keeps_its_old_id() {
    let mover = || part("Mover", 0.25).with_child(part("Rider", 0.25));
    let old = root(vec![folder("A").with_child(mover())]);
    let new = root(vec![folder("A"), folder("Fresh").with_child(mover())]);
    let output = diff_with_properties(&compact(&old), &mut compact(&new), &DiffConfig::default());
    let document = &output.document;

    let mover_id = node(&document.old, "Mover").id;
    let rider_id = node(&document.old, "Rider").id;
    assert_eq!(node(&document.new, "Mover").id, mover_id);

    // The add lists the whole new subtree, moved instances included; readers
    // skip entries the old manifest has, and the reparent op places them.
    let subtree: Vec<u32> = document
        .ops
        .iter()
        .find_map(|op| match op {
            DocumentOp::Add { subtree, .. } => Some(subtree.iter().map(|added| added.id).collect()),
            _ => None,
        })
        .expect("Fresh is added");
    assert!(subtree.contains(&mover_id) && subtree.contains(&rider_id));
    assert!(document.ops.iter().any(|op| matches!(
        op,
        DocumentOp::Reparent { id, .. } if *id == mover_id
    )));
}

fn cframe_x(x: f32) -> CFrame {
    CFrame::new(
        Vector3::new(x, 0.0, 0.0),
        Matrix3::new(
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        ),
    )
}

fn truck(offset: f32) -> WeakDom {
    let placed = |name: &str, x: f32| {
        InstanceBuilder::new("Part")
            .with_name(name)
            .with_property("CFrame", Variant::CFrame(cframe_x(offset + x)))
    };
    WeakDom::new(
        InstanceBuilder::new("DataModel")
            .with_name("root")
            .with_child(
                InstanceBuilder::new("Model")
                    .with_name("Truck")
                    .with_property(
                        "WorldPivotData",
                        Variant::OptionalCFrame(Some(cframe_x(offset))),
                    )
                    .with_child(placed("A", 0.0))
                    .with_child(placed("B", 4.0))
                    .with_child(placed("C", 8.0)),
            ),
    )
}

#[test]
fn properties_are_read_before_pivot_factoring() {
    let output = diff_with_properties(
        &compact(&truck(0.0)),
        &mut compact(&truck(10.0)),
        &DiffConfig::default(),
    );
    assert!(
        !output.document.pivots.is_empty(),
        "moving the whole model is a pivot"
    );
    // Factoring rewrites the new side's world-space properties in place; the
    // properties are the file as authored.
    for (name, x) in [("A", 10.0), ("B", 14.0), ("C", 18.0)] {
        let id = node(&output.document.new, name).id;
        match output.properties.new[&id].get("CFrame") {
            Some(PropertyValue::CFrame(value)) => assert_eq!(value.components[0], x, "{name}"),
            other => panic!("{name} CFrame: {other:?}"),
        }
    }
}

#[test]
fn show_lists_every_instance_with_properties() {
    let dom = root(vec![folder("A").with_child(part("P", 0.5))]);
    let output = show(&compact(&dom), &DiffConfig::default());

    // The file's top level is `root`'s children (see `compact`).
    let names: Vec<&str> = output
        .instances
        .iter()
        .map(|instance| instance.name.as_str())
        .collect();
    assert_eq!(names, ["A", "P"], "depth-first, file order");
    assert_eq!(shown(&output.instances, "A").parent, None);
    assert_eq!(
        shown(&output.instances, "P").parent,
        Some(shown(&output.instances, "A").id)
    );
    assert_eq!(
        transparency(shown(&output.instances, "P").properties.get("Transparency")),
        Some(0.5)
    );
    assert_eq!(
        render_text(&output),
        "A [Folder]\n  P [Part]\n    Transparency = 0.5\n"
    );
}

#[test]
fn defaults_fill_in_what_instances_leave_out() {
    let dom = root(vec![folder("A").with_child(part("P", 0.5))]);
    let output = show(&compact(&dom), &DiffConfig::default());
    let part_defaults = &output.defaults["Part"];
    // An instance lists only what differs from these.
    assert_eq!(transparency(part_defaults.get("Transparency")), Some(0.0));
    assert!(matches!(
        part_defaults.get("Anchored"),
        Some(PropertyValue::Bool { value: false })
    ));
    assert!(
        !shown(&output.instances, "P")
            .properties
            .contains_key("Anchored"),
        "a default value isn't repeated per instance"
    );
    assert!(output.defaults.contains_key("Folder"));
    assert!(
        part_defaults
            .keys()
            .all(|name| !name.starts_with("Attributes") && !name.starts_with("Tags")),
        "containers have no defaults"
    );
}

#[test]
fn content_names_the_properties_that_point_at_assets() {
    let dom = root(vec![InstanceBuilder::new("MeshPart")
        .with_name("M")
        .with_child(InstanceBuilder::new("ParticleEmitter").with_name("E"))]);
    let output = show(&compact(&dom), &DiffConfig::default());
    for (class, property) in [
        ("MeshPart", "MeshContent"),
        ("MeshPart", "TextureContent"),
        ("ParticleEmitter", "Texture"),
    ] {
        assert!(
            output.content[class].iter().any(|name| name == property),
            "{class}.{property} is Content-typed"
        );
    }
    assert!(!output.content["MeshPart"]
        .iter()
        .any(|name| name == "Transparency"));
}
