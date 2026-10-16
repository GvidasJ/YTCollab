# YT Collab Helper

A personal Chrome extension (Manifest V3, plain JS, no build step) that drives
YouTube Studio's **Collaborations** feature between your own channels:

- **Invite** your other channels to a video from its Details page or the upload
  dialog. It always turns analytics access on, and refuses to create a link if
  it can't confirm that.
- **Accept** the invites on each invited channel.
- **Manage** every collaboration in a full tab, including **removing** a
  collaborator from a video.
- **Hand off** invites between Chrome profiles with one copy/paste code.

It clicks what you would click in your logged-in browser. It doesn't call
YouTube's internal APIs.

> **Status:** the plumbing, UI, storage, channel detection, hand-off codes,
> dry run and recorder are done. The Studio steps for invite, accept and
> remove are mapped from a recording of your own Studio (see
> [FLOW.md](FLOW.md)). Until then they stop before clicking anything.

## Install (in every Chrome profile you use)

1. Put this folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick this folder.
4. Pin the extension (puzzle icon → pin) so the popup is one click away.

Repeat in each profile: Load unpacked from the same folder. After editing
any file, press the reload icon on the extension's card, then reload open
Studio tabs.

## First run

1. In each channel's profile, open the popup and press **Save this channel**.
   It opens Studio and the channel's public page briefly in background tabs
   to read the channel ID, name and handle.
2. Bring all channels into the uploading profile: in each other profile press
   **Copy pending invites** (it carries your saved channels too) or use
   Options → **Export**, then **Paste code…** / Options → **Import** in the
   uploading profile.
3. Options: check names and handles, reorder. **Dry run** is on by default.

## Everyday use

**Invite** (uploading channel's profile): open the video's Details page or
the upload dialog → popup → tick channels → **Invite selected**, or press
**Invite** on one row. You can close the popup; progress keeps running and
shows when you reopen it. Each row shows live progress, a plain-English error
with **Retry**, or the invite status with **Copy link** (for channels you
don't manage).

**Hand off**: popup → **Copy pending invites**. In the invited channel's
profile: popup → **Paste code…** → **Import**.

**Accept** (invited channel's profile): popup shows only the signed-in
channel's pending invites → **Accept** or **Accept all**. It confirms the
right channel is signed in, opens the link in a background tab, clicks
Accept, checks it worked, marks it accepted and closes the tab. Wrong channel
→ it tells you which one to switch to. Link not active yet → stays pending
with a note.

**Send results back** (optional): in the invited profile **Copy accepted
(send back)**, paste it in the uploading profile to update its history.

**Manager tab**: popup → **Manager**. Every invite grouped by video, with
filters and bulk actions:
- **Accept**, **Retry**, **Copy link**
- **Remove from video**: takes the collaborator off the video in Studio. Run
  it in the uploading channel's profile. It confirms with you first, checks
  the signed-in channel, opens the video's Details page and clicks only that
  collaborator's remove control. Dry run applies.
- **Remove from list**: deletes the local record only. YouTube isn't touched.

## Dry run

Options → **Dry run** (on by default). Safe steps still happen so every step
can be shown: expanding sections, opening the invite dialog, typing the
search. Anything that creates, accepts or removes something is only outlined
(dashed orange), and the run stops there. Turn it off once the outlines land
on the right things.

## Safety rules built in

- Analytics access must read as on (`aria-checked` / `checked`) before
  **Create link**; otherwise the run stops. The service worker also rejects
  any result without that confirmation.
- Picks the channel by channel ID or exact handle only, never a lookalike.
- Only touches the Collaboration section and the accept page. Never changes
  other settings or visibility. Never presses Studio's **Save** on its own.
- One action at a time with a short pause. Waits use MutationObserver plus a
  timeout, never fixed sleeps.
- Anything unexpected (an extra dialog, an error, a verification prompt,
  something covering the button) stops the run and reports it. A batch stops
  at the first such error.
- Invite links are only opened if they're on YouTube's hosts.

## Permissions

`storage`, `tabs`, `scripting`, and host access to `studio.youtube.com` and
`www.youtube.com` only. If recordings show the invite links live on another
host, it gets added here and in `selectors.js → urls.inviteLinkHosts`.

## Files

| File | What it does |
|---|---|
| `selectors.js` | **Every** selector, URL pattern and UI string, commented. Usually the only file to edit when Studio changes |
| `background.js` | Service worker: job queue, channel detection, storage writes, hand-off codes, recorder storage |
| `content/dom.js` | Shadow-root-aware queries, MutationObserver waits, clicks, typing, checked-state, highlighter |
| `content/flows.js` | Invite / accept / remove step lists (filled in from FLOW.md) |
| `content/recorder.js` | Discovery recorder |
| `content/agent.js` | Page context + runs flows when the service worker asks |
| `popup/` | The popup |
| `manager/` | Manager tab |
| `options/` | Options page |
| `lib/` | Shared helpers, storage schema, merge rules, code format |
| `FLOW.md` | Step → selector → how each step is verified |

## When YouTube changes something

Symptoms: a run stops with "Timed out waiting for …", "… not found", or
"Something is covering …".

1. Turn **Dry run** on and run it again. The numbered outlines show the last
   step that still works.
2. Popup → **Recorder** → **Start recording**, do that step by hand, add a
   note, **Snapshot this page**, **Stop**, **Download**.
3. In the recording, find the click event for the step: `target.selector`,
   `target.id`, `target.ariaLabel`, `target.role`, and the `before` / `after`
   snapshots. Pick the most stable hook: id → `ytcp-*` tag → aria-label →
   role. Never a CSS class.
4. Update that key in `selectors.js`, bump `version` at the top, reload the
   extension, dry run again.
5. If the step itself changed (a new dialog, a moved option), update FLOW.md
   and the step in `content/flows.js`, or send the recording over.

If channel detection breaks ("Timed out waiting for Studio to show the
signed-in channel"): check that opening `studio.youtube.com` still redirects
to `/channel/UC…`. If it doesn't, update `urls.studioChannelPath`.
