# Maps

The Workspace is built around a map. This page describes what each map view draws, the difference between a route
and a candidate edge, the synchronised maps of the comparison pages, replay, and how the basemap tiles are
configured and what their usage policy requires.

A problem has a map only when it declares one. `capabilities = frozenset({"map"})` says that its instances carry
`drivers` and `riders` with `origin` and `destination` coordinates; `"playback"` adds route replay. A problem without
geography — the synthetic assignment benchmark — shows charts in the place of the map, and the comparison page says
*This problem has no map.*

## The Workspace map

| What you see | Meaning |
|---|---|
| Squares with a vehicle icon | drivers at their start point; colour and icon give the vehicle type (electric, combustion, hybrid, plug-in hybrid) |
| Person icons | riders at their start point |
| Hollow markers | destinations |
| Filled arrow up / hollow arrow down | pick-up / drop-off of the selected solution |
| Solid line / dashed line | a shared ride / a driver who drives alone |
| Dashed grey rider | a rider the selected solution does not serve |

Hovering a marker gives its details; markers at the same place fan out. The legend on the map names every symbol.
Without a selected method the map shows the scenario; ticking a method under *Displayed methods* and clicking its
name shows that method's validated solution. *Displayed methods* controls what is shown; *Methods to run* is a
separate list for a new run.

**Scenario navigation.** With several scenarios, the scenario navigation switches between *All N
scenarios* and one scenario by its real name, with previous / next buttons, a list and — for long lists — a search
box that jumps to a scenario by name. The map always shows one scenario.

**Expanded map.** The expand button gives the map the whole window: the header and side panels give way, the action
bar stays, panels open on demand, **Esc** returns to the normal layout. The map view (centre and zoom) is saved with
the Workspace view of the account and restored on return.

## Inspecting a participant or a vehicle

Clicking a marker opens a card with what the frozen scenario records about that participant and what the selected
validated solution does with it.

| Section | Content |
|---|---|
| Recorded in the scenario | identifier, role, vehicle type and passenger capacity (drivers), time window, start and destination coordinates, the detour constraint |
| Problem-specific properties | whatever the problem returns from `Problem.participant_properties(instance)` as `{participant id: [[label, value], ...]}` |
| In the selected solution | the assignment and the route; *This vehicle is not used by the selected solution* when it is not |
| Editing | *Edit this vehicle…* or *Edit participants…* opens a **new scenario version**; the frozen scenario and its results stay unchanged |

A problem whose scenarios cannot be edited in the interface sets `authoring_note`; the card then shows that text in
place of the edit buttons. Without a note it reads *This problem provides no scenario editor: its scenarios are frozen
records.* Both come from `GET /api/geo/instances/{hash}/participants`, which applies the same workspace check as the
scenario itself. The card is read-only: nothing shown in it is computed by a method.

## Add participants

Drivers, riders and their vehicles are authored in the **Participants & Vehicles** step of the scenario editor
(*Generate*, or **+ Driver**, **+ Rider**, **Randomize** and *Edit participants…* in the Workspace, which open the
editor on a **new version** of the shown scenario — a frozen scenario and its results are never changed). Nothing is
stored before *Save Scenario* or *Save & Run*, and the editor predicts and solves nothing.

**Randomize** opens one dialog: number of drivers and riders (or drivers per rider), the share of combustion, hybrid
and electric vehicles among the scenario's vehicle profiles, seats per vehicle, the whole area or a rectangle adjusted
on a small map, the departure time or interval, the departure window of drivers and the pick-up window of riders, the
detour limits, the minimum trip length and a **seed**. *Generate* asks the server, which draws every start and end
point on the road network and checks the result; the participants appear on the map at once and stay editable. The
same settings and seed always give the same scenario; the generator, seed and settings are recorded in the scenario's
provenance, and later hand edits are listed with it. A request that cannot be honoured is refused with what to change
— a rectangle without a road node, shares that do not add up to 100 %, a capacity below 1, an interval that ends
before it starts.

**By hand**, the palette holds *Driver*, *Rider* and the vehicle types:

1. drag an item onto the map, or select it and click the map (the way to do it on a touch screen);
2. click the destination;
3. fill the small form — departure window (driver) or pick-up window (rider), an optional *Arrive by*, and for a driver
   the vehicle type and seats — and press **Save participant**.

Clicking a marker (or an identifier in the list) opens the same form for an existing participant; a marker can be
dragged to another place. Every point is snapped to the road network; a point outside the working area or too far from
a road is refused with a message and nothing changes. **Undo** (or Ctrl+Z) takes back the last change, **Cancel**
leaves a participant as it was.

| The public ride-matching problem | In the editor |
|---|---|
| one rider per driver | the seats are recorded with the vehicle profile; another number of seats makes a profile derived from the chosen one |
| departure window per driver, pick-up window per rider, no drop-off window | two times per participant; *Arrive by* is an arrival by the direct trip: refused when the direct travel time does not allow it, otherwise it brings the latest departure or pick-up forward |
| detour limits for the whole scenario | set in the dialog or in the Constraints step, shown read-only in the form |

A problem that sets `authoring_note` keeps showing that note instead of these tools. Server side, the generator and
the checks are in `move_openlab.mobility.authoring`; the editor uses `POST /api/geo/scenarios/preview` (with
`authoring` parameters), `GET /api/geo/networks/{id}/snap` and `POST /api/geo/networks/{id}/participant`.
`scripts/e2e/authoring.mjs` drives the whole path in a browser on the synthetic grid.

## Routes and logical candidate edges

Two kinds of lines can be drawn, and they must not be confused.

| | Routes | Candidate edges |
|---|---|---|
| What a line is | the path of a vehicle of a **validated solution** | a **logical edge of the formulation** between two stops, drawn as a straight line |
| Follows roads | yes, when road geometry is available | no — it is not a road route |
| Shown for | every problem with `playback` | problems that declare `candidates`, for a run whose method removed candidates before solving |
| Counted in | riders served, detour, distance | vehicle-edges: pairs (vehicle, edge) |

For such a run the map offers four views:

| View | Draws |
|---|---|
| **Routes** | the validated solution on road geometry |
| **Before** | every candidate of the scenario, before any reduction |
| **After** | candidates retained and removed by the method's policy, and those kept by a structural rule |
| **Solution** | the candidates used by the validated solution |

The legend gives the counts and the reduction, and a vehicle filter restricts the view to one vehicle. The data comes
from the recorded run (`Problem.candidate_view`, `GET /api/geo/candidates/{campaign}/{run}`); it is never recomputed.
A **preview** of the reduction a method would apply with the settings being edited uses the same view
(`Problem.candidate_preview`); the legend then says that nothing was solved
([ML_INTEGRATION.md](ML_INTEGRATION.md#candidate-view-and-preview)). The two public problems declare neither
capability.

**Where route geometry comes from.** Routes follow the road network when it is stored on the installation. For an
imported experiment whose network is not installed here, they follow the replay geometry that came with the bundle.
Without either, legs are drawn as straight segments. In all three cases the travel times are those frozen in the
scenario: the drawing never changes a result.

## Replay

*Replay routes* animates the selected solution over time: vehicles, pick-ups, drop-offs, served and unserved riders,
on one clock. It is served by `GET /api/geo/playback/{campaign}/{run}` for a run of a problem with `playback`; a problem may draw its own routes by overriding `Problem.playback`. Replay is display only.

## Synchronised maps

**Compare → Methods → Maps** shows two methods side by side on the same scenario.

| Control | Effect |
|---|---|
| A, B | which two of the selected methods are shown |
| Routes / Before / After / Solution | the same view on both maps (the last three when the problem declares `candidates`) |
| Vehicle | one filter for both maps |
| *Synchronised maps* | both maps pan and zoom together |
| *Replay both* | one clock for the two replays: the union of the two timelines |

Under the candidate views a table counts the differences between the two recorded runs, in vehicle-edges: removed
by the policy, and used by the validated solution — only A, both, only B. At least two methods must be selected.

**Compare → Experiments → Maps** and **Replay** show experiment A next to the selected experiment B, with the same
*Synchronised maps* option and one replay clock; **Diff** lists the differences scenario by scenario. Scenarios of
two experiments are matched by their frozen instance, by derivation, or by equal problem fingerprint — never by
position.

## Areas and road networks on the map

In *Library › Data setup › 1 · Area and road network* an area is created by place search, by a click or by drawing
a box, and adjusted by its handles. The coverage of a stored network is shown on the map with its node and edge
counts; *Measure route* gives the free-flow distance and travel time between two points
([DATASETS.md](DATASETS.md#areas-and-road-networks)).

## Tiles

The basemap is drawn by the browser from a tile service. The server never downloads tiles.

| Variable | Default | Meaning |
|---|---|---|
| `MOVE_OPENLAB_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | tile URL template; `none` (or `off`) = maps without a basemap |
| `MOVE_OPENLAB_TILE_ATTRIBUTION` | © OpenStreetMap contributors | attribution shown on every map |

**Usage policy.** The default is the OpenStreetMap standard tile service. Its
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) allows light interactive use with
attribution; it is not a service for a public deployment. An installation open to many users must point
`MOVE_OPENLAB_TILE_URL` at its own tile server or at a provider whose terms allow the use, set the matching
attribution, or run without a basemap. This choice is on the release checklist ([RELEASING.md](RELEASING.md)).

What the application does to follow the policy and to limit exposure:

- the attribution is always displayed;
- tile requests carry the page origin as referrer (`strict-origin-when-cross-origin`), never the path;
- the Content Security Policy allows images from the configured tile origin only;
- with `MOVE_OPENLAB_TILE_URL=none` no tile request is made at all.

**Without tiles.** When tiles cannot be loaded — no network, a blocked service — the map shows *Basemap unavailable —
data still shown* and keeps markers, routes and coverage. Everything except the background works offline.

**Data licence.** Road networks, travel times and route geometry are derived from OpenStreetMap data, © OpenStreetMap
contributors, under the Open Database License 1.0. A road network or derived database shared publicly must keep the
attribution and the licence ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
