//! A file's instances with their properties (`git rbx show`), and the same
//! properties for both sides of a diff document (`diff --format json
//! --with-properties`), for anything that shows unchanged instances next to
//! the changes, like an editor viewer.
//!
//! Properties are the authored, non-default ones the diff compares, with
//! Attributes and Tags expanded per key as the document names them. Each
//! output also carries `defaults`, every property's default value per class,
//! so a reader can show every property without it being repeated per
//! instance, and `content`, each class's Content and ContentId properties,
//! whose values point at assets.

use rbx_dom_weak::types::{Ref, Variant, VariantType};
use rbx_reflection::DataType;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

use crate::diff::{should_compare_property, variant_to_property_value};
use crate::diff_document::authored_properties;
use crate::diff_dom::{DiffDom, DomView};
use crate::explorer_tree::capture_tree;
use crate::output::format_property_value;
use crate::{diff_model_compact_doms_document_with_ids, DiffConfig, DiffDocument, PropertyValue};

pub type Properties = BTreeMap<String, PropertyValue>;

#[derive(Debug, Serialize)]
pub struct ShownInstance {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    pub name: String,
    pub class: String,
    pub properties: Properties,
}

/// `git rbx show --format json`: every instance, depth-first in file order.
#[derive(Debug, Serialize)]
pub struct Shown {
    pub instances: Vec<ShownInstance>,
    pub defaults: BTreeMap<String, Properties>,
    pub content: BTreeMap<String, Vec<String>>,
}

/// `diff --format json --with-properties`: the diff document, unchanged, plus
/// each side's properties keyed by the document's manifest ids.
#[derive(Debug, Serialize)]
pub struct DocumentWithProperties {
    #[serde(flatten)]
    pub document: DiffDocument,
    pub properties: SideProperties,
    pub defaults: BTreeMap<String, Properties>,
    pub content: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct SideProperties {
    pub old: BTreeMap<u32, Properties>,
    pub new: BTreeMap<u32, Properties>,
}

pub fn show(dom: &DiffDom, config: &DiffConfig) -> Shown {
    let (tree, ids) = capture_tree(dom, &HashMap::new(), &mut 1);
    let mut properties = by_id(properties_by_ref(dom, config), &ids);
    let instances: Vec<ShownInstance> = tree
        .nodes
        .into_iter()
        .map(|node| ShownInstance {
            properties: properties.remove(&node.id).unwrap_or_default(),
            id: node.id,
            parent: node.parent,
            name: node.name,
            class: node.class_name,
        })
        .collect();
    let classes: Vec<&str> = instances
        .iter()
        .map(|instance| instance.class.as_str())
        .collect();
    Shown {
        defaults: class_defaults(&classes, config),
        content: content_properties(&classes),
        instances,
    }
}

pub fn diff_with_properties(
    old: &DiffDom,
    new: &mut DiffDom,
    config: &DiffConfig,
) -> DocumentWithProperties {
    // Captured before diffing: pivot factoring rewrites world-space properties
    // on the new side in place, and these show the file as authored.
    let old_properties = properties_by_ref(old, config);
    let new_properties = properties_by_ref(new, config);
    let (document, old_ids, new_ids) = diff_model_compact_doms_document_with_ids(old, new, config);
    let classes: Vec<&str> = document
        .old
        .iter()
        .chain(&document.new)
        .map(|node| node.class.as_str())
        .collect();
    let defaults = class_defaults(&classes, config);
    let content = content_properties(&classes);
    DocumentWithProperties {
        properties: SideProperties {
            old: by_id(old_properties, &old_ids),
            new: by_id(new_properties, &new_ids),
        },
        defaults,
        content,
        document,
    }
}

/// `git rbx show` (text): the instance tree, each instance's properties under
/// it before its children, values as the diff prints them except that
/// strings and references are whole.
pub fn render_text(shown: &Shown) -> String {
    let mut children: HashMap<Option<u32>, Vec<&ShownInstance>> = HashMap::new();
    for instance in &shown.instances {
        children.entry(instance.parent).or_default().push(instance);
    }
    let mut out = String::new();
    let mut stack: Vec<(&ShownInstance, usize)> = children
        .get(&None)
        .map(|roots| roots.iter().rev().map(|root| (*root, 0)).collect())
        .unwrap_or_default();
    while let Some((instance, depth)) = stack.pop() {
        let indent = "  ".repeat(depth);
        out.push_str(&format!("{indent}{} [{}]\n", instance.name, instance.class));
        for (name, value) in &instance.properties {
            out.push_str(&format!("{indent}  {name} = {}\n", text_value(value)));
        }
        if let Some(kids) = children.get(&Some(instance.id)) {
            stack.extend(kids.iter().rev().map(|kid| (*kid, depth + 1)));
        }
    }
    out
}

fn text_value(value: &PropertyValue) -> String {
    match value {
        PropertyValue::String { value } => format!("{value:?}"),
        PropertyValue::Ref { value, .. } => format!("Ref({value})"),
        other => format_property_value(other),
    }
}

fn properties_by_ref(dom: &DiffDom, config: &DiffConfig) -> HashMap<Ref, Properties> {
    let mut properties = HashMap::new();
    let mut stack = vec![dom.root_ref()];
    while let Some(referent) = stack.pop() {
        let instance = dom
            .get_by_ref(referent)
            .expect("refs reached from the root resolve");
        stack.extend(instance.children());
        if referent != dom.root_ref() {
            // Ref values name their target by path.
            properties.insert(
                referent,
                authored_properties(dom, &HashMap::new(), referent, config),
            );
        }
    }
    properties
}

fn by_id(
    mut properties: HashMap<Ref, Properties>,
    ids: &HashMap<Ref, u32>,
) -> BTreeMap<u32, Properties> {
    ids.iter()
        .filter_map(|(referent, id)| Some((*id, properties.remove(referent)?)))
        .collect()
}

/// The reflection defaults of the properties `authored_properties` lists, per
/// class. Attributes and Tags have none; an unset reference is nil.
fn class_defaults(classes: &[&str], config: &DiffConfig) -> BTreeMap<String, Properties> {
    let database = rbx_reflection_database::get().unwrap();
    let mut defaults = BTreeMap::new();
    for &class in classes {
        if defaults.contains_key(class) {
            continue;
        }
        let mut properties = BTreeMap::new();
        if let Some(descriptor) = database.classes.get(class) {
            for (name, value) in &descriptor.default_properties {
                let name: &str = name.as_ref();
                if config.ignore_properties.contains(name) || !should_compare_property(class, name)
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
        defaults.insert(class.to_string(), properties);
    }
    defaults
}

/// The properties typed Content or ContentId, inherited ones included, per
/// class.
fn content_properties(classes: &[&str]) -> BTreeMap<String, Vec<String>> {
    let database = rbx_reflection_database::get().unwrap();
    let mut content = BTreeMap::new();
    for &class in classes {
        if content.contains_key(class) {
            continue;
        }
        let mut names = Vec::new();
        if let Some(descriptor) = database.classes.get(class) {
            for ancestor in database.superclasses_iter(descriptor) {
                for (name, property) in &ancestor.properties {
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
        content.insert(class.to_string(), names);
    }
    content
}
