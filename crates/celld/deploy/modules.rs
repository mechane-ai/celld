// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Explicit, byte-preserving module discovery for an unbundled deployment.

use super::project_relative_path;
use crate::protocol::ModuleKind;
use anyhow::{anyhow, bail, Context};
use glob::{MatchOptions, Pattern};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub(super) struct Inventory {
    directory: PathBuf,
    entry: PathBuf,
    pub main: String,
    rules: Vec<Rule>,
}

struct Rule {
    kind: Kind,
    patterns: Vec<Pattern>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    EsModule,
    Wasm,
}

pub(super) struct Module {
    pub name: String,
    pub bytes: Vec<u8>,
    pub kind: ModuleKind,
}

pub(super) fn read(
    object: &Map<String, Value>,
    root: &Path,
    entry: Option<&str>,
    no_bundle: bool,
) -> anyhow::Result<Option<Inventory>> {
    let enabled = match object.get("find_additional_modules") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => bail!("config `find_additional_modules` must be a boolean"),
    };
    if !enabled {
        if object.contains_key("base_dir") {
            bail!("config `base_dir` requires `find_additional_modules: true`");
        }
        return Ok(None);
    }
    if !no_bundle {
        bail!("`find_additional_modules` currently requires `no_bundle: true`");
    }
    let entry = root.join(entry.context("`find_additional_modules` requires `main`")?);
    let project = root
        .canonicalize()
        .context("resolve module project directory")?;
    let directory = match object.get("base_dir") {
        None => entry
            .parent()
            .context("entry has no directory")?
            .to_path_buf(),
        Some(Value::String(value)) if value == "." || value == "./" => root.to_path_buf(),
        Some(Value::String(value)) => root.join(project_relative_path(value, "base_dir")?),
        Some(_) => bail!("config `base_dir` must be a string"),
    };
    let directory = directory
        .canonicalize()
        .context("resolve module `base_dir`")?;
    if !directory.starts_with(&project) || !directory.is_dir() {
        bail!("config `base_dir` must be a directory inside the project");
    }
    let entry = entry.canonicalize().context("resolve module entry")?;
    let main = entry
        .strip_prefix(&directory)
        .context("config `main` must be inside `base_dir`")?
        .to_str()
        .context("module entry path is not UTF-8")?
        .replace(std::path::MAIN_SEPARATOR, "/");
    crate::protocol::validate_module_name(&main)?;
    let configured = match object.get("rules") {
        None => &[][..],
        Some(Value::Array(rules)) => rules.as_slice(),
        Some(_) => bail!("config `rules` must be an array"),
    };
    let mut rules = Vec::new();
    let mut closed = BTreeSet::new();
    for configured in configured {
        let rule = configured
            .as_object()
            .context("module rule must be an object")?;
        for key in rule.keys() {
            if !matches!(key.as_str(), "type" | "globs" | "fallthrough") {
                bail!("module rule sets unsupported key {key:?}");
            }
        }
        let kind = match rule.get("type").and_then(Value::as_str) {
            Some("ESModule") => Kind::EsModule,
            Some("CompiledWasm") => Kind::Wasm,
            other => bail!("unsupported unbundled module type {other:?}; supported types are ESModule and CompiledWasm"),
        };
        if closed.contains(&kind) {
            bail!("a previous module rule of this type requires `fallthrough: true`");
        }
        let fallthrough = match rule.get("fallthrough") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => bail!("module rule `fallthrough` must be a boolean"),
        };
        let globs = rule
            .get("globs")
            .and_then(Value::as_array)
            .filter(|globs| !globs.is_empty())
            .context("module rule requires a nonempty `globs` array")?;
        let mut patterns = Vec::new();
        for value in globs {
            let pattern = value
                .as_str()
                .context("module rule glob must be a string")?;
            let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
            if pattern.is_empty()
                || pattern.contains('\\')
                || pattern.chars().any(char::is_control)
                || pattern
                    .split('/')
                    .any(|part| matches!(part, "" | "." | ".."))
            {
                bail!("module rule glob must stay inside `base_dir`: {pattern:?}");
            }
            patterns.push(
                Pattern::new(pattern)
                    .with_context(|| format!("invalid module glob {pattern:?}"))?,
            );
        }
        rules.push(Rule { kind, patterns });
        if !fallthrough {
            closed.insert(kind);
        }
    }
    if !closed.contains(&Kind::Wasm) {
        rules.push(Rule {
            kind: Kind::Wasm,
            patterns: vec![
                Pattern::new("**/*.wasm")?,
                Pattern::new("**/*.wasm[?]module")?,
            ],
        });
    }
    Ok(Some(Inventory {
        directory,
        entry,
        main,
        rules,
    }))
}

impl Inventory {
    pub fn collect(&self) -> anyhow::Result<Vec<Module>> {
        let mut modules = Vec::new();
        visit(&self.directory, "", &mut |path, name, file_type| {
            if path == self.entry {
                return Ok(());
            }
            let mut selected = None;
            for rule in &self.rules {
                let options = MatchOptions {
                    case_sensitive: true,
                    require_literal_separator: true,
                    require_literal_leading_dot: true,
                };
                if rule
                    .patterns
                    .iter()
                    .any(|pattern| pattern.matches_with(name, options))
                {
                    if selected.is_some_and(|previous| previous != rule.kind) {
                        bail!("conflicting module types for {name:?}");
                    }
                    selected = Some(rule.kind);
                }
            }
            let Some(kind) = selected else { return Ok(()) };
            if !file_type.is_file() {
                bail!("module {} is not a regular file", path.display());
            }
            crate::protocol::validate_module_name(name)?;
            let bytes =
                std::fs::read(path).with_context(|| format!("read module {}", path.display()))?;
            if kind != Kind::Wasm {
                std::str::from_utf8(&bytes)
                    .with_context(|| format!("module {name:?} is not UTF-8"))?;
            }
            modules.push(Module {
                name: name.to_string(),
                bytes,
                kind: match kind {
                    Kind::EsModule => ModuleKind::EsModule,
                    Kind::Wasm => ModuleKind::Wasm,
                },
            });
            Ok(())
        })?;
        modules.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(modules)
    }
}

/// Walk regular directories without following links or entering local state.
pub(super) fn visit(
    directory: &Path,
    relative: &str,
    visitor: &mut impl FnMut(&Path, &str, std::fs::FileType) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("read module directory {}", directory.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("non-UTF-8 module path under {}", directory.display()))?;
        if file_type.is_dir() && matches!(name.as_str(), ".git" | ".celld" | ".wrangler") {
            continue;
        }
        if name.contains(['\\', '\0']) {
            bail!("invalid module path component {name:?}");
        }
        let name = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        if file_type.is_dir() {
            visit(&path, &name, visitor)?;
        } else {
            visitor(&path, &name, file_type)?;
        }
    }
    Ok(())
}
