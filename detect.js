// What a file is: the one test of whether a parsed value is a workflow the check reads, and in which
// format. The check reads files by this same test, and so does this Action (check.js, which sends only
// what it takes), so the Action never skips a file the check would read and never sends one the check
// would refuse as not a workflow. No import.

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);

// A Dify app's export: its DSL, with the graph under `workflow`.
function isDify(v) {
  const g = v.workflow && typeof v.workflow === "object" ? v.workflow.graph : null;
  return !!g && typeof g === "object" && Array.isArray(g.nodes) && Array.isArray(g.edges) && (v.kind === "app" || (v.app && typeof v.app === "object"));
}

// A Power Automate flow's or a Logic App's definition: a `$schema` naming the workflow
// definition language, or both `triggers` and `actions` as objects.
function isFlowDefinition(x) {
  return isObject(x) && ((typeof x.$schema === "string" && /workflowdefinition/i.test(x.$schema)) || (isObject(x.triggers) && isObject(x.actions)));
}

// The definitions a value holds, where the check looks for them: bare, under `definition`, under
// `properties.definition`, or under a `resources` entry's `properties.definition` at any depth.
export function flowDefinitions(v) {
  if (!isObject(v)) return [];
  if (isFlowDefinition(v)) return [v];
  if (isFlowDefinition(v.definition)) return [v.definition];
  if (isObject(v.properties) && isFlowDefinition(v.properties.definition)) return [v.properties.definition];
  const out = [];
  const inTemplate = (t) => {
    if (!isObject(t) || !Array.isArray(t.resources)) return;
    for (const r of t.resources) {
      if (!isObject(r) || !isObject(r.properties)) continue;
      if (isFlowDefinition(r.properties.definition)) out.push(r.properties.definition);
      inTemplate(r.properties.template);
    }
  };
  inTemplate(v);
  return out;
}

export function detect(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (isDify(value)) return "dify";
    if (flowDefinitions(value).length) return "powerautomate";
    if (value.workflow && typeof value.workflow === "object" && Array.isArray(value.workflow.nodes)) return "n8n";
    if (Array.isArray(value.nodes) && value.connections && typeof value.connections === "object") return "n8n";
    if (Array.isArray(value.nodes) && Array.isArray(value.edges)) return "langgraph";
    if (value.graph && Array.isArray(value.graph.nodes) && Array.isArray(value.graph.edges)) return "langgraph";
  }
  return null;
}
