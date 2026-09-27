//! Input for editor viewers: the diff document between two versions (the
//! same one `diff --json` prints and the Studio diff viewer reads), plus each
//! version's instances with their authored properties, so a viewer can show
//! unchanged instances too.
//!
//! Instances carry the document's manifest ids: an instance matched across
//! versions has the same id on both sides, and the document's ops address
//! those ids. The instance lists replace the document's manifests, which are
//! left empty, and hold the properties its added subtrees would repeat, which
//! are cleared. A single file gets the same instance list with no document.
//!
//! Instances list only their non-default properties; `defaults` holds each
//! class's default values, so a viewer can show every property without the
//! output repeating them per instance. `content` names each class's
//! Content and ContentId properties, whose values point at assets a viewer
//! can preview.

use rbx_dom_weak::types::{Ref, Variant, VariantType};
use rbx_reflection::DataType;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

use crate::compact_diff::compute_compact_changes_with_identity;
use crate::diff::{should_compare_property, variant_to_property_value};
use crate::diff_document::{authored_properties, build_with_ids, ManifestNode};
use crate::diff_dom::{DiffDom, DomView};
use crate::explorer_tree::capture_tree;
use crate::model_normalize::prepare_model_diff_pivots_view;
use crate::{DiffConfig, DiffDocument, DocumentOp, PropertyValue};

#[derive(Debug, Serialize)]
pub struct ViewInstance {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    pub name: String,
    pub class: String,
    /// Authored, non-default properties, as the document lists an added
    /// instance's: Attributes and Tags expanded per key.
    pub properties: BTreeMap<String, PropertyValue>,
}

#[derive(Debug, Serialize)]
pub struct ViewDocument {
    /// The old version's instances, when two versions were given.
    pub old: Option<Vec<ViewInstance>>,
    pub new: Vec<ViewInstance>,
    pub document: Option<DiffDocument>,
    /// Per class in either version: the default value of each property an
    /// instance of it would list when set.
    pub defaults: BTreeMap<String, BTreeMap<String, PropertyValue>>,
    /// Per class in either version: its properties typed Content or ContentId.
    pub content: BTreeMap<String, Vec<String>>,
}

pub fn view_document(old: Option<&DiffDom>, new: &mut DiffDom) -> ViewDocument {
    let config = DiffConfig::default();
    let Some(old) = old else {
        let (tree, ids) = capture_tree(new, &HashMap::new(), &mut 1);
        let manifest = tree.nodes.into_iter().map(|node| ManifestNode {
            id: node.id,
            parent: node.parent,
            name: node.name,
            class: node.class_name,
        });
        let new = instances(manifest, &ids, properties_by_ref(new, &config));
        return ViewDocument {
            old: None,
            defaults: class_defaults(&new, &config),
            content: content_properties(&new),
            new,
            document: None,
        };
    };

    // Captured before diffing: pivot factoring rewrites world-space properties
    // on the new side in place, and a viewer shows the file as authored.
    let old_properties = properties_by_ref(old, &config);
    let new_properties = properties_by_ref(new, &config);

    // The same steps as the model diff document, keeping the ids it assigns.
    let normalization = prepare_model_diff_pivots_view(old, new);
    let changes = compute_compact_changes_with_identity(
        old,
        new,
        &normalization.identity,
        normalization.pivot_ops(),
        &config,
    );
    let (mut document, old_ids, new_ids) = build_with_ids(old, new, &changes, &config);

    let old_instances = instances(
        std::mem::take(&mut document.old).into_iter(),
        &old_ids,
        old_properties,
    );
    let new_instances = instances(
        std::mem::take(&mut document.new).into_iter(),
        &new_ids,
        new_properties,
    );
    // The instance lists already hold everything an added subtree repeats.
    for op in &mut document.ops {
        if let DocumentOp::Add { subtree, .. } = op {
            for added in subtree {
                added.properties.clear();
            }
        }
    }
    let mut defaults = class_defaults(&old_instances, &config);
    defaults.extend(class_defaults(&new_instances, &config));
    let mut content = content_properties(&old_instances);
    content.extend(content_properties(&new_instances));
    ViewDocument {
        old: Some(old_instances),
        new: new_instances,
        document: Some(document),
        defaults,
        content,
    }
}

fn properties_by_ref(
    dom: &DiffDom,
    config: &DiffConfig,
) -> HashMap<Ref, BTreeMap<String, PropertyValue>> {
    let mut properties = HashMap::new();
    let mut stack = vec![dom.root_ref()];
    while let Some(referent) = stack.pop() {
        let instance = dom
            .get_by_ref(referent)
            .expect("refs reached from the root resolve");
        stack.extend(instance.children());
        if referent != dom.root_ref() {
            // Ref values name their target by path; ids aren't assigned yet.
            properties.insert(
                referent,
                authored_properties(dom, &HashMap::new(), referent, config),
            );
        }
    }
    properties
}

fn instances(
    manifest: impl Iterator<Item = ManifestNode>,
    ids: &HashMap<Ref, u32>,
    mut properties: HashMap<Ref, BTreeMap<String, PropertyValue>>,
) -> Vec<ViewInstance> {
    let refs: HashMap<u32, Ref> = ids.iter().map(|(referent, id)| (*id, *referent)).collect();
    manifest
        .map(|node| ViewInstance {
            properties: refs
                .get(&node.id)
                .and_then(|referent| properties.remove(referent))
                .unwrap_or_default(),
            id: node.id,
            parent: node.parent,
            name: node.name,
            class: node.class,
        })
        .collect()
}

/// The reflection defaults of the properties `authored_properties` lists for
/// each class among `instances`. Attributes and Tags have none; an unset
/// reference is nil.
fn class_defaults(
    instances: &[ViewInstance],
    config: &DiffConfig,
) -> BTreeMap<String, BTreeMap<String, PropertyValue>> {
    let database = rbx_reflection_database::get().unwrap();
    let mut defaults = BTreeMap::new();
    for instance in instances {
        if defaults.contains_key(&instance.class) {
            continue;
        }
        let mut properties = BTreeMap::new();
        if let Some(descriptor) = database.classes.get(instance.class.as_str()) {
            for (name, value) in &descriptor.default_properties {
                let name: &str = name.as_ref();
                if config.ignore_properties.contains(name)
                    || !should_compare_property(&instance.class, name)
                {
                    continue;
                }
                let value = match value {
                    Variant::Attributes(_) | Variant::Tags(_) => continue,
                    Variant::Ref(r) if r.is_none() => PropertyValue::Nil,
                    value => variant_to_property_value(value),
                };
                properties.insert(name.to_string(), value);
            }
        }
        defaults.insert(instance.class.clone(), properties);
    }
    defaults
}

/// The properties typed Content or ContentId, inherited ones included, of each
/// class among `instances`.
fn content_properties(instances: &[ViewInstance]) -> BTreeMap<String, Vec<String>> {
    let database = rbx_reflection_database::get().unwrap();
    let mut content = BTreeMap::new();
    for instance in instances {
        if content.contains_key(&instance.class) {
            continue;
        }
        let mut names = Vec::new();
        if let Some(descriptor) = database.classes.get(instance.class.as_str()) {
            for class in database.superclasses_iter(descriptor) {
                for (name, property) in &class.properties {
                    if matches!(
                        property.data_type,
                        DataType::Value(VariantType::Content | VariantType::ContentId)
                    ) {
                        names.push(name.to_string());
                    }
                }
            }
        }
        names.sort();
        content.insert(instance.class.clone(), names);
    }
    content
}
