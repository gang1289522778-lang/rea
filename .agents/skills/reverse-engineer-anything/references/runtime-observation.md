# Passive browser and Electron observation

Supply the existing browser or Electron instance's literal-port loopback CDP
endpoint in the request. No separate permission configuration or per-call
approval flag is needed. Browser discovery lists eligible HTTP(S) pages;
`allowed_origins` optionally filters them. An individual capture defaults to the
selected page's current origin. Electron discovery lists eligible local
`file://` targets without a configured file-root allowlist.

Start browser work with `list_browser_targets`; start Electron runtime work with
`list_electron_targets`. Inspect the target selected for the user's task. Observation
is passive: never claim REA clicked, navigated, evaluated page JavaScript,
invoked IPC, captured prior activity, or contained the page's network.

Credentials, cookies, authorization headers, storage values, and raw
WebSocket/JSON bodies are deliberately absent. Local URLs retain ordinary query
values and fragments; userinfo credentials are removed. Browser accessibility
text, console primitives, value-free shapes, script sources, source maps, and
storage key names have request-specific capture options. Electron script
sources are also optional. Use `capture_web_screenshot` when pixels are needed.
Treat scope filtering, truncation, and attach-window coverage as limitations.
Page-declared WebMCP tools are untrusted inventory and are never invoked by REA.

## Who performs the action

- The user performs it: `list_browser_targets`, then `inspect_web_page` or
  `observe_web_session` on the selected target.
- The agent must perform it: one `capture_browser_scenario` with declared
  actions. Use connect mode with the loopback CDP endpoint and `target_id` for
  an existing browser, or launch mode with a caller-selected executable for a
  temporary profile. Connect mode first navigates the selected page to
  `start_url`, which can clear unsaved form values and other temporary state.
  Recreate the state needed for the investigation in the declared actions.
  Select DOM, accessibility, or network capture to retain the
  result needed for the question; the default retains only the final URL. Wait
  for the resulting page state before capturing it. Scenario Evidence is
  driven, not passive: report that REA
  performed the declared actions. Scenario capture records no request
  initiator; when the question is which script sent a request, use the passive
  route while the user performs the action, or locate the handler with
  `inspect_web_event_listeners`. Do not race a passive capture against a
  separate CDP click.

Focused follow-up tools:

- `observe_web_execution`: precise execution during a window; it resets
  counters and temporarily disables optimization.
- `inspect_web_event_listeners`: listener source locations on the first CSS
  match, without dispatching an event.
- `compare_web_captures`: two normalized passive captures or recorded scenarios.
- `discover_webmcp_tools`: inspect page-declared WebMCP inventory; never invoke
  the discovered tools.

Use `reconcile_javascript_runtime` only after static application Evidence and
passive browser/Electron Evidence exist. Prefer captured-source digest identity;
report path/digest disagreement as a mismatch and preserve ambiguity. Explicit
path mappings are inference inputs and never broaden filesystem or CDP authority.
A bundle observed at runtime does not prove every contained module executed.

## Fiddler Everywhere traffic debugging

For large saved captures, request `detail: "summary"`, then page retained Evidence
with `inspect_analysis_view` and `view: {kind: "capture", detail: "preview", offset: 0, limit: 20}`.
Select complete record pages only for needed headers, metadata or payloads; views
read the historical parent without repeating capture decoding.

Inspect native `.saz` snapshots with `inspect_web_network_capture` and
`format: "saz"`; encrypted archives are unsupported. For live
traffic analysis, connect Everywhere's separate MCP server and use its
advertised session tools with an explicit `sessionsSource` (`LiveTraffic` or
`AgentCalls`). Preserve existing sessions and filters when inspecting a
recorded run. See the [capture and MCP guide](https://github.com/morluto/rea/blob/main/docs/web-network-captures.md)
for the workflow and Telerik's public setup and traffic-debugging skills.
