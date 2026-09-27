//! `git rbx view`: the diff document plus each version's instances, keyed by
//! the document's ids, as the editor viewer reads them.
use git_rbx::view::{view_document, ViewInstance};
use git_rbx::{DiffDom, DocumentOp, PropertyValue};
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

fn named<'a>(instances: &'a [ViewInstance], name: &str) -> &'a ViewInstance {
    instances
        .iter()
        .find(|instance| instance.name == name)
        .unwrap_or_else(|| panic!("no instance named {name}"))
}

fn has_id(instances: &[ViewInstance], id: u32) -> bool {
    instances.iter().any(|instance| instance.id == id)
}

#[test]
fn matched_instances_share_ids_and_ops_address_them() {
    let old = root(vec![folder("A").with_child(part("P", 0.25)).with_child(
        InstanceBuilder::new("Model")
            .with_name("Gone")
            .with_child(part("G", 0.25)),
    )]);
    let new = root(vec![
        folder("A").with_child(part("P", 0.5)),
        folder("Fresh").with_child(part("F", 0.75)),
    ]);
    let view = view_document(Some(&compact(&old)), &mut compact(&new));
    let old_instances = view.old.as_ref().unwrap();
    let document = view.document.as_ref().unwrap();

    let p = named(&view.new, "P");
    assert_eq!(
        named(old_instances, "P").id,
        p.id,
        "a matched instance keeps its id"
    );
    assert!(matches!(
        p.properties.get("Transparency"),
        Some(PropertyValue::Float32 { value }) if *value == 0.5
    ));

    for op in &document.ops {
        match op {
            DocumentOp::SetProperty { id, property, .. } => {
                assert_eq!((*id, property.as_str()), (p.id, "Transparency"));
            }
            DocumentOp::Remove { id, .. } => {
                assert_eq!(*id, named(old_instances, "Gone").id);
                assert!(
                    !has_id(&view.new, *id),
                    "a removed instance is only in the old list"
                );
            }
            DocumentOp::Add { id, subtree, .. } => {
                assert_eq!(*id, named(&view.new, "Fresh").id);
                assert!(
                    !has_id(old_instances, *id),
                    "an added instance is only in the new list"
                );
                // The instance lists carry what the document would repeat.
                assert!(subtree.iter().all(|added| added.properties.is_empty()));
            }
            other => panic!("unexpected op {other:?}"),
        }
    }
    assert!(
        document.old.is_empty() && document.new.is_empty(),
        "the instance lists replace the manifests"
    );
    assert!(matches!(
        named(&view.new, "F").properties.get("Transparency"),
        Some(PropertyValue::Float32 { value }) if *value == 0.75
    ));
}

#[test]
fn moved_into_an_added_subtree_keeps_its_old_id() {
    let mover = || part("Mover", 0.25).with_child(part("Rider", 0.25));
    let old = root(vec![folder("A").with_child(mover())]);
    let new = root(vec![folder("A"), folder("Fresh").with_child(mover())]);
    let view = view_document(Some(&compact(&old)), &mut compact(&new));
    let old_instances = view.old.as_ref().unwrap();
    let document = view.document.as_ref().unwrap();

    let mover_id = named(old_instances, "Mover").id;
    let rider_id = named(old_instances, "Rider").id;
    assert_eq!(named(&view.new, "Mover").id, mover_id);

    // The add lists the whole new subtree, moved instances included; a
    // viewer skips entries it finds in the old list, and the reparent op
    // places the moved instance.
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
    let view = view_document(Some(&compact(&truck(0.0))), &mut compact(&truck(10.0)));
    assert!(
        !view.document.as_ref().unwrap().pivots.is_empty(),
        "moving the whole model is a pivot"
    );
    // Factoring rewrites the new side's world-space properties in place; the
    // viewer shows the file as authored.
    for (name, x) in [("A", 10.0), ("B", 14.0), ("C", 18.0)] {
        match named(&view.new, name).properties.get("CFrame") {
            Some(PropertyValue::CFrame(value)) => assert_eq!(value.components[0], x, "{name}"),
            other => panic!("{name} CFrame: {other:?}"),
        }
    }
}

#[test]
fn a_single_file_lists_every_instance_with_properties() {
    let dom = root(vec![folder("A").with_child(part("P", 0.5))]);
    let view = view_document(None, &mut compact(&dom));
    assert!(view.old.is_none() && view.document.is_none());

    // The file's top level is `root`'s children (see `compact`).
    let names: Vec<&str> = view
        .new
        .iter()
        .map(|instance| instance.name.as_str())
        .collect();
    assert_eq!(names, ["A", "P"], "depth-first, file order");
    assert_eq!(named(&view.new, "A").parent, None);
    assert_eq!(named(&view.new, "P").parent, Some(named(&view.new, "A").id));
    assert!(named(&view.new, "P")
        .properties
        .contains_key("Transparency"));
}

#[test]
fn defaults_fill_in_what_instances_leave_out() {
    let dom = root(vec![folder("A").with_child(part("P", 0.5))]);
    let view = view_document(None, &mut compact(&dom));
    let part_defaults = &view.defaults["Part"];
    // The instance lists only what differs from these.
    assert!(matches!(
        part_defaults.get("Transparency"),
        Some(PropertyValue::Float32 { value }) if *value == 0.0
    ));
    assert!(matches!(
        part_defaults.get("Anchored"),
        Some(PropertyValue::Bool { value: false })
    ));
    assert!(
        !named(&view.new, "P").properties.contains_key("Anchored"),
        "a default value isn't repeated per instance"
    );
    assert!(view.defaults.contains_key("Folder"));
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
    let view = view_document(None, &mut compact(&dom));
    for (class, property) in [
        ("MeshPart", "MeshContent"),
        ("MeshPart", "TextureContent"),
        ("ParticleEmitter", "Texture"),
    ] {
        assert!(
            view.content[class].iter().any(|name| name == property),
            "{class}.{property} is Content-typed"
        );
    }
    assert!(!view.content["MeshPart"]
        .iter()
        .any(|name| name == "Transparency"));
}
