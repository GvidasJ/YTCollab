# FLOW.md: how the automation drives Studio

This file is the map from each step to the selector it uses and the check
that proves it worked. **Status: pre-discovery.** No invite, accept or remove
step is automated yet. They're written from a real recording of your Studio,
not guessed. Until then those flows stop at once with "This flow hasn't been
mapped to your Studio yet", before anything is clicked.

Every selector lives in `selectors.js`. Every step below names its key there.

## What is already known (no recording needed)

| What | How | Source |
|---|---|---|
| Signed-in channel | Open `https://studio.youtube.com/` in a background tab; Studio redirects to `/channel/<UC…id>/…`; read the ID from the URL, close the tab | Long-standing Studio behaviour |
| Channel name + handle | Open `https://www.youtube.com/channel/<id>` in a background tab; MAIN-world script reads `ytInitialData.metadata.channelMetadataRenderer` (`title`, `externalId`, `vanityChannelUrl` → `@handle`); falls back to `og:title` | Public channel page |
| Video ID on the Details page | URL `studio.youtube.com/video/<id>/edit` | Public URL format |
| Video ID in the upload dialog | `?udvid=<id>` in the URL, or a `youtu.be/<id>` link inside `ytcp-uploads-dialog` | UNVERIFIED, read-only |
| Invite path in the UI | Details → Audience → **Show more** → Collaboration → **Invite a collaborator** → search handle → analytics option → **Create link** | YouTube Help + guides |
| Accept path | Open the invite link signed in as the invited channel → **Accept** | Guides |
| Limit | 10 collaborators per video | YouTube Help |
| Link activation | Links work only after the upload has finished | Guides |

## Open questions the recording answers

1. **Shadow DOM.** Do Studio's `ytcp-*` components use real shadow roots? Each
   snapshot reports `shadowRoots`. Public automation scripts drive Studio with
   XPath, which suggests light DOM. The helpers pierce shadow roots either way.
2. **One link per collaborator, or one shared link?** The dialog snapshot after
   "Create link" shows whether the link is tied to the chosen channel.
3. **Is "Create link" enough, or does Studio also need Save?** The snapshot of
   the Details page after closing the dialog shows whether the Save button
   became enabled. If Save is needed you'll be asked how to handle it: the
   extension never presses Save on its own.
4. **Analytics option.** Its exact wording, where it sits (in the dialog or per
   result), and which element carries `aria-checked` / `checked`.
5. **Search results.** Does each result expose the channel ID (a link or an
   attribute) or only name + handle? This decides the exact-match rule (ID
   first, else exact handle, never a lookalike).
6. **Invite link format and domain.** Recorded through the copy button
   (`clipboard` event) or the link field (`data-rec-value`). The manifest's
   host permissions must cover it.
7. **Accept page.** URL, where it shows the signed-in channel, the Accept
   button, the success state, and the "not active yet" / error states.
8. **Remove.** The collaborator row, its remove control (button or menu),
   any confirmation dialog, and whether removal also needs Save.

## How to record (one pass on each side)

Install the extension in **every** Chrome profile you use (Load unpacked from
the same folder). In each recording, add a note in the popup before each
step, e.g. "now clicking Create link". It makes the log easy to read.

### Recording A: in the uploading channel's profile

1. Open the popup → **Recorder** → **Start recording**. A red badge appears
   at the bottom-left of YouTube pages.
2. Open your video's Details page in Studio (`studio.youtube.com/video/<id>/edit`).
3. By hand: click **Show more** → under Collaboration click **Invite a
   collaborator** → type one of your channels' handles → pick it → turn on
   the analytics option → **Create link** → click the copy button → close
   the dialog the way you normally would.
4. Popup → **Snapshot this page** (with the Collaboration section open, so the
   new collaborator row shows).
5. Look at Studio's **Save** button. Is it enabled now? Add a note saying so.
   Don't press it unless you'd normally have to; if you do press it, add a
   note.
6. Removal (optional, but needed for the Manager's "Remove from video"): on
   the same video, remove that collaborator by hand and confirm any dialog.
   Snapshot the page again. You can invite them again afterwards.
7. Popup → **Stop recording** → **Download** (or **Copy recording**), and
   send me the file.

### Recording B: in the invited channel's profile

1. Popup → **Start recording**.
2. Open the invite link from recording A.
3. Popup → **Snapshot this page** *before* clicking anything.
4. Click **Accept**. Wait until the page settles, then **Snapshot this page**
   again.
5. If you have one: open a link for a video that's still processing, or a
   link meant for another channel, and snapshot those pages too (they show
   the error states).
6. **Stop recording** → **Download** → send it.

## Step map (filled in after discovery)

Action classes: **safe** steps reveal UI (dry run performs them so later steps
can be shown). **commit** steps create, accept or remove something (dry run
only outlines them, dashed orange, and stops).

### Invite one channel (runs in the video's tab)

| # | Step | Class | Selector key | Verify |
|---|---|---|---|---|
| 1 | Expand **Show more** (skip if already open) | safe | `invite.showMoreButton` | `invite.collaborationSection` visible |
| 2 | Click **Invite a collaborator** | safe | `invite.inviteButton` | `invite.inviteDialog` visible |
| 3 | Type the handle | safe | `invite.searchInput` | field value = handle |
| 4 | Pick the exact result (channel ID, else exact handle; zero or several matches → stop) | PENDING | `invite.searchResult`, `invite.resultChannelId`, `invite.resultHandle` | result marked selected |
| 5 | Turn analytics access on | PENDING | `invite.analyticsOption` | `invite.analyticsState` reads on (`aria-checked="true"` / `checked`); else **stop, no link** |
| 6 | **Create link** | commit | `invite.createLinkButton` | `invite.linkField` holds a link on an allowed host |
| 7 | Read the link | n/a | `invite.linkField` | matches `urls.inviteLinkPattern` |
| 8 | Close the dialog | PENDING | `invite.closeButton` | dialog gone; collaborator row present |

Hard rules in code: step 6 can't run unless step 5 confirmed "on". The
service worker refuses any result without `analyticsVerified: true`. Any
unexpected dialog, alert or covering overlay stops the run.

### Accept (runs in a tab on the invite link)

| # | Step | Class | Selector key | Verify |
|---|---|---|---|---|
| 0 | Signed-in channel = invited channel (Studio probe, before the tab opens) | n/a | `urls.studioChannelPath` | IDs equal; else "switch to …" |
| 1 | Page loaded, on an allowed host, no sign-in / verification page | n/a | `common.verificationHosts` | URL host |
| 2 | Not-active / error states | n/a | `accept.notActiveMarker`, `accept.errorMarker` | LINK_NOT_ACTIVE keeps it pending |
| 3 | Signed-in channel shown on the page (if shown) | n/a | `accept.signedInChannel` | matches the invited channel |
| 4 | Click **Accept** | commit | `accept.acceptButton` | `accept.successMarker` appears |

### Remove a collaborator (Manager tab; runs on the video's Details page)

| # | Step | Class | Selector key | Verify |
|---|---|---|---|---|
| 0 | Signed-in channel = uploading channel | n/a | `urls.studioChannelPath` | else "switch to …" |
| 1 | Expand **Show more** | safe | `invite.showMoreButton` | Collaboration section visible |
| 2 | Find the row for this channel (ID, else exact handle) | n/a | `invite.collaboratorRow`, `remove.rowChannelId`, `remove.rowHandle` | exactly one row; none → COLLABORATOR_NOT_FOUND |
| 3 | Click its remove control (and the menu item, if any) | commit | `remove.removeButton`, `remove.removeMenuItem` | confirm dialog or row gone |
| 4 | Confirm, if asked | commit | `remove.confirmDialog`, `remove.confirmButton` | row gone |
| 5 | Save needed? | PENDING | `invite.saveButton` | if yes, ask (never pressed automatically) |
