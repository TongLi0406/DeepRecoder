# Recorder Interface Redesign

Approved direction: task-first recording tool with readable daily journals, restrained
motion, white surfaces, graphite text, green emphasis and red recording state.

## Scope

- Four main destinations: Record, Diary, Library, Ask. Library contains recordings and
  skills as local tabs. Settings is reachable from each main-page header and returns
  to the originating page. Existing summary and recording routes remain compatible.
- Record uses compact meeting/classroom and role selectors, a single start action and
  recent real recordings. Starting opens the existing recording surface and starts
  only because the user pressed the start control; merely opening a page never records.
- Diary leads with date navigation, current capture state and daily content. Enrollment,
  models, retention and destructive controls move into a collapsible settings panel.
  Existing segment review and identity correction remain available on demand.
- Web explicitly presents unavailable native capture as a platform state, not a wall of
  disabled controls. Do not simulate diary capture or fabricate recorded content.
- Restyle library, skills, Ask, Settings and summary surfaces with the same typography,
  spacing and color tokens. Preserve source warnings, provider configuration and export.

## Visual and Interaction Rules

- Use Manrope for interface text and Newsreader for journal prose. Fonts are bundled.
- Use Lucide icons and accessible names/tooltips for icon commands. No decorative emoji.
- Repeated items may have radius <=8; sections remain unframed and are separated by rules.
- Primary controls have >=44px targets. Selectors expose selected state; settings and
  review panels expose expanded state. Loading, error, empty and blocked states remain clear.
- Use a short fade/6px entrance and brief content expansion. A subtle recording ring
  expresses recording state only, never microphone amplitude. Stop loops when paused,
  backgrounded, unfocused or when reduced motion is requested. Reduced motion defaults
  to enabled until its OS setting is known. No decorative perpetual animation.
- Mobile uses bottom navigation; wide screens use a compact sidebar and bounded content.
  No viewport-scaled font sizes, clipped navigation labels or horizontal overflow.

## Safety and Acceptance

Keep the established single-recorder ownership and diary/ordinary-recording exclusion.
Keep cloud-upload consent and explicit deletion confirmation. No native capture or
power/voice-accuracy claim can be inferred from this frontend work.

Verify actual page controls and state changes with focused Node rendering tests,
TypeScript, Web export and Playwright at 1280x900, 390x844 and 320x740. Check normal and
reduced motion, page navigation, settings return, library tabs and collapsed diary tools.
Keep the existing software suite green and the Android hardware gates explicitly open.
