/*
 * YT Collab Helper: every YouTube selector, URL pattern and UI text string.
 *
 * When YouTube changes Studio, this should be the ONLY file you need to edit.
 * README.md ("When YouTube changes something") explains how to find new values
 * with the built-in recorder.
 *
 * Rules for this file
 *  - Prefer stable hooks: element ids, ytcp-* / tp-yt-* tag names, aria-labels,
 *    roles. Never CSS class names; Studio regenerates them.
 *  - Text strings are for Studio in English (US). Matching ignores case and
 *    collapses whitespace.
 *  - Every entry carries a status tag in its comment:
 *      VERIFIED <date>  seen in a real recording of your Studio
 *      FROM-DOCS        wording from YouTube Help, not yet seen in the DOM
 *      UNVERIFIED       an educated guess used only for read-only display;
 *                       nothing is ever clicked based on it
 *      PENDING          not discovered yet (value is null)
 *  - A flow refuses to run while any selector it needs is null, so a missing
 *    selector can never turn into a guessed click.
 *
 * Loaded as a classic script by the service worker (importScripts), the popup,
 * the options page and the content scripts. It only defines data.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});

  YTC.SEL = {
    // Bump when you edit this file; it is written into recordings and errors.
    version: '2026-10-12 pre-discovery',

    // Do Studio's components need shadow-root piercing? The recorder reports
    // how many shadow roots it met (`shadowRoots` in each snapshot). Public
    // automation scripts drive Studio with plain XPath, which suggests light
    // DOM, but the helpers pierce open shadow roots anyway until the
    // recording says otherwise. UNVERIFIED
    pierceShadowRoots: true,

    // ------------------------------------------------------------------
    // URLs
    // ------------------------------------------------------------------
    urls: {
      studioOrigin: 'https://studio.youtube.com',
      youtubeOrigin: 'https://www.youtube.com',

      // Opening Studio's root sends you to /channel/<active channel id>/...
      // That is how the active (signed-in) channel is detected. VERIFIED by
      // long-standing Studio behaviour; re-check if detection breaks.
      studioRoot: 'https://studio.youtube.com/',
      studioChannelPath: /^\/channel\/(UC[\w-]{22})(?:[/?#]|$)/,

      // A video's Details page. VERIFIED (stable public URL format).
      studioVideoEditPath: /^\/video\/([\w-]{11})\/(?:edit|details)(?:[/?#]|$)/,

      // While the upload dialog is open Studio adds ?d=ud and, once the
      // file is accepted, &udvid=<videoId>. UNVERIFIED (read-only use).
      uploadDialogParam: 'd',
      uploadDialogValue: 'ud',
      uploadVideoIdParam: 'udvid',

      // Public channel page, used to read a channel's name and handle.
      publicChannelUrl: (channelId) => `https://www.youtube.com/channel/${channelId}`,

      // Invite links. PENDING: the recording of "Create link" shows the real
      // format. Until then any https link on these hosts is accepted, and the
      // manifest's host_permissions must cover the host.
      inviteLinkHosts: ['www.youtube.com', 'youtube.com', 'studio.youtube.com', 'm.youtube.com', 'youtu.be'],
      inviteLinkPattern: null,
    },

    // ------------------------------------------------------------------
    // Reading a channel's name / handle on its public page
    // (www.youtube.com/channel/UC...), via a MAIN-world script.
    // ------------------------------------------------------------------
    channelPage: {
      // window.ytInitialData.metadata.channelMetadataRenderer has
      // { title, externalId, vanityChannelUrl: "http://www.youtube.com/@handle" }.
      // UNVERIFIED for your channels; if it fails, the popup asks you to type
      // the handle in Options.
      metadataPath: ['ytInitialData', 'metadata', 'channelMetadataRenderer'],
      handleFromVanityUrl: /\/(@[^/?#]+)/,
      // Fallback when the metadata is missing.
      ogTitle: 'meta[property="og:title"]',
    },

    // ------------------------------------------------------------------
    // Page context: which video is open (read-only, never clicked)
    // ------------------------------------------------------------------
    context: {
      // The upload wizard's root element. UNVERIFIED (seen in public
      // automation scripts).
      uploadDialog: 'ytcp-uploads-dialog',
      // Inside the upload dialog the sidebar shows the video's short link.
      // Any visible link to youtu.be/<id> inside the dialog counts. UNVERIFIED
      uploadVideoLink: 'a[href*="youtu.be/"]',
      videoIdFromLink: /youtu\.be\/([\w-]{11})/,
      // Title text box on the Details page / upload dialog. PENDING
      videoTitle: null,
    },

    // ------------------------------------------------------------------
    // INVITE flow (on the uploading channel). Everything here is PENDING
    // until the discovery recording comes back; FLOW.md has the step list.
    // ------------------------------------------------------------------
    invite: {
      // Details → Audience → "Show more" toggle that reveals Collaboration.
      showMoreButton: null, // PENDING
      // The Collaboration section container once expanded.
      collaborationSection: null, // PENDING
      // "Invite a collaborator" button inside the section.
      inviteButton: null, // PENDING
      // The invite dialog root.
      inviteDialog: null, // PENDING
      // Search box inside the invite dialog.
      searchInput: null, // PENDING
      // One entry in the search results list.
      searchResult: null, // PENDING
      // Inside a result: where its channel ID / handle can be read.
      resultChannelId: null, // PENDING (attribute or link holding UC…)
      resultHandle: null, // PENDING
      // The analytics-access option (checkbox / toggle) and the element
      // whose checked / aria-checked state proves it is on.
      analyticsOption: null, // PENDING
      analyticsState: null, // PENDING
      // "Create link" button.
      createLinkButton: null, // PENDING
      // Where the created link appears (input value or text).
      linkField: null, // PENDING
      // How to close the dialog after the link is captured.
      closeButton: null, // PENDING
      // Studio's Save button on the Details page, if the invite needs it.
      // Discovery decides; the extension never clicks Save without asking.
      saveButton: null, // PENDING
      // Collaborator rows already listed in the section (to avoid duplicates
      // and show accepted / pending state).
      collaboratorRow: null, // PENDING
    },

    // ------------------------------------------------------------------
    // ACCEPT flow (on the invited channel, opening the invite link). PENDING
    // ------------------------------------------------------------------
    accept: {
      // Root of the accept page / dialog.
      root: null, // PENDING
      // The "Accept" button.
      acceptButton: null, // PENDING
      // Where the page shows which channel is signed in (if it does).
      signedInChannel: null, // PENDING
      // What the page shows after a successful accept.
      successMarker: null, // PENDING
      // What the page shows when the link is not active yet (upload still
      // processing) or is invalid / expired / for another channel.
      notActiveMarker: null, // PENDING
      errorMarker: null, // PENDING
    },

    // ------------------------------------------------------------------
    // REMOVE flow (on the uploading channel: take a collaborator off a
    // video from the Manager tab). Uses invite.showMoreButton and
    // invite.collaboratorRow to reach the list. PENDING
    // ------------------------------------------------------------------
    remove: {
      // Inside a collaborator row: where its channel ID / handle can be read.
      rowChannelId: null, // PENDING
      rowHandle: null, // PENDING
      // The row's remove control (button or overflow menu).
      removeButton: null, // PENDING
      // If removal goes through a menu: the "Remove" menu item.
      removeMenuItem: null, // PENDING
      // Confirmation dialog and its confirm button, if Studio asks.
      confirmDialog: null, // PENDING
      confirmButton: null, // PENDING
    },

    // ------------------------------------------------------------------
    // UI text (English US). FROM-DOCS = YouTube Help wording.
    // ------------------------------------------------------------------
    text: {
      showMore: 'Show more', // FROM-DOCS
      collaborationHeading: 'Collaboration', // FROM-DOCS
      inviteCollaborator: 'Invite a collaborator', // FROM-DOCS
      createLink: 'Create link', // FROM-DOCS (third-party guides write "Create Link")
      accept: 'Accept', // FROM-DOCS
      analyticsOption: null, // PENDING: exact wording of the analytics-access option
      linkNotActive: null, // PENDING: wording shown when a link isn't active yet
      handleNotFound: null, // PENDING: wording of the "no results" state
      remove: null, // PENDING: wording of the remove control / menu item
      confirmRemove: null, // PENDING: wording of the confirm button
    },

    // ------------------------------------------------------------------
    // Generic hooks for things that should NOT be there. A flow stops when
    // one of these appears unexpectedly. Roles are standard ARIA, so these
    // are safe to use before discovery.
    // ------------------------------------------------------------------
    common: {
      dialogs: [
        'tp-yt-paper-dialog',
        'ytcp-dialog',
        'ytcp-uploads-dialog',
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        'dialog[open]',
      ],
      alerts: ['[role="alert"]', '[role="alertdialog"]'],
      // Google sign-in / verification pages mean "stop and hand over".
      verificationHosts: ['accounts.google.com'],
    },

    // ------------------------------------------------------------------
    // Recorder (discovery mode). These only decide what gets captured.
    // ------------------------------------------------------------------
    recorder: {
      // Popups / menus / dropdowns to capture besides dialogs.
      popups: ['tp-yt-iron-dropdown', 'ytcp-text-menu', '[role="listbox"]', '[role="menu"]'],
      // A click's "neighbourhood" snapshot grows up the tree until the
      // ancestor would contain more than this many elements.
      neighborhoodMaxElements: 450,
      // Size caps (characters of serialized HTML).
      maxSnapshotChars: 400000,
      maxPageSnapshotChars: 1500000,
      maxTotalChars: 7000000,
      maxEvents: 800,
      // Left out of snapshots completely.
      dropTags: ['script', 'style', 'link', 'meta', 'noscript', 'template', 'iron-iconset-svg'],
      // Kept with their attributes, but their contents are left out.
      emptyTags: ['svg', 'canvas', 'video', 'audio', 'iframe', 'img'],
    },
  };
})();
