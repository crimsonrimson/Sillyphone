// ===================================================================
// Phone UI - Texts & Social  (SillyTavern extension)
//
// Adds a phone-style panel with:
//   - Texts: per-character SMS-style threads
//   - Feed: social media posts with #tags and @mentions
//   - Discord: servers you get invited to, with channels and chat
//   - Contacts: auto-populated from characters who've texted/posted
//   - Compose: write a text or a post, tag people with @
//
// HOW THE LLM TALKS BACK:
// This extension watches incoming chat messages for these tags:
//   [TEXT:CharacterName] message text here
//   [POST:CharacterName] caption text here #tag @mention
//   [DISCORD_INVITE:ServerName:CharacterName] invite message here
//   [DISCORD:ServerName>ChannelName:CharacterName] message text here
//   [FOLLOW:CharacterName] - CharacterName follows the user
//   [LIKE:CharacterName] - CharacterName likes the user's latest post
//   [COMMENT:CharacterName] comment text here - comments on the
//     user's latest post
// Add a line like this to your character's Author's Note / system
// prompt so the model knows to use them, e.g.:
//   "When texting the user, prefix the line with [TEXT:YourName].
//    When posting to social media, prefix it with [POST:YourName].
//    When inviting the user to a Discord server, use
//    [DISCORD_INVITE:ServerName:YourName]. When talking in a server
//    channel, use [DISCORD:ServerName>ChannelName:YourName]. To
//    follow the user on social media, use [FOLLOW:YourName]. To like
//    the user's latest post, use [LIKE:YourName]. To comment on it,
//    use [COMMENT:YourName] your comment text."
// Anything tagged this way is pulled into the phone UI. You can
// still leave normal narration untagged - only tagged lines route
// into the phone.
// ===================================================================

const MODULE_NAME = "phoneUI";

let context;

// structuredClone isn't available in every environment this extension
// ends up running in (notably some older/embedded Android WebViews
// that SillyTavern mobile companion apps use). Every default object
// this file clones is plain JSON-safe data (no functions, Dates,
// Maps, etc.), so a JSON round-trip is a perfectly safe fallback -
// and critically, it means a missing structuredClone can never throw
// and take down the rest of init (see safeClone call sites below).
function safeClone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (e) {
      /* fall through to JSON fallback */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

// Shows a small dismissible banner at the top of the screen. Used so
// load failures are visible on mobile, where there's no easy way to
// open the browser console to see console.error output.
function showLoadError(message) {
  try {
    const d = document.createElement("div");
    d.textContent = "[PhoneUI] " + message;
    d.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#b91c1c;color:#fff;font-size:12px;padding:8px 12px;" +
      "text-align:center;font-family:sans-serif;cursor:pointer;";
    d.title = "Tap to dismiss";
    d.addEventListener("click", () => d.remove());
    document.body.appendChild(d);
  } catch (e) {
    /* if this fails too, there's nothing left to do */
  }
}

// Different SillyTavern versions expose context differently: newer
// builds have a global SillyTavern.getContext(), older ones expect
// you to import from relative paths instead. This tries the modern
// path first (retrying for up to ~15s in case core ST hasn't finished
// loading yet when this script runs), then falls back to the
// import-based approach, retried a few times too, so the extension
// works either way instead of failing on one mistimed attempt.
async function resolveContext() {
  for (let i = 0; i < 60; i++) {
    if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
      try {
        const ctx = SillyTavern.getContext();
        if (ctx) return ctx;
      } catch (e) {
        /* not ready yet, retry */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const extMod = await import("../../../extensions.js");
      const scriptMod = await import("../../../../script.js");
      if (extMod.extension_settings) {
        return {
          extensionSettings: extMod.extension_settings,
          saveSettingsDebounced: scriptMod.saveSettingsDebounced,
          eventSource: scriptMod.eventSource,
          event_types: scriptMod.event_types,
          name1: scriptMod.name1,
          chat: scriptMod.chat,
          // Older builds export chat metadata as a plain module-level
          // object/function rather than putting it on a context
          // object; these may be undefined on some versions, and
          // getChatDataStore()/saveSettings() already handle that.
          chatMetadata: scriptMod.chat_metadata,
          saveMetadataDebounced: scriptMod.saveMetadataDebounced,
          saveMetadata: scriptMod.saveMetadata,
          // Needed for silent (non-chat-visible) LLM use: injecting
          // hidden context notes and running a background generation.
          // Both may be undefined on older builds that don't export
          // them - every call site below feature-detects before using
          // either, so that degrades gracefully instead of throwing.
          setExtensionPrompt: scriptMod.setExtensionPrompt,
          extension_prompt_types: extMod.extension_prompt_types,
          extension_prompt_roles: extMod.extension_prompt_roles,
          generateQuietPrompt: scriptMod.generateQuietPrompt,
        };
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("[PhoneUI] Could not resolve SillyTavern context via fallback import either.", lastErr);
  showLoadError(
    "Failed to load: could not connect to SillyTavern (" +
      (lastErr ? lastErr.message : "context API unavailable") +
      "). Open the browser console for details."
  );
  return null;
}

// Bug fix: `context` (above) is a one-time snapshot grabbed at init
// via resolveContext(), so context.name1 used to freeze at whatever
// persona was active when the extension first loaded - switching
// personas in SillyTavern's UI afterward never showed up on the
// phone. name1 is the one field on that snapshot that regularly
// changes out from under it, so every call site reads it through
// here instead of the stale `context.name1` directly: this re-asks
// SillyTavern for the live value each time, falling back to the
// cached snapshot (and then "User") only if that's unavailable.
function currentPersonaName() {
  try {
    if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
      const ctx = SillyTavern.getContext();
      if (ctx && ctx.name1) return ctx.name1;
    }
  } catch (e) {
    /* fall through to the cached snapshot */
  }
  return (context && context.name1) || "User";
}


// Per-chat phone content (texts, feed, Discord, contacts). Stored in
// the current chat's metadata so switching chats gives each character
// their own independent phone state instead of one global inbox.
const defaultChatData = {
  contacts: {},   // { name: { avatar: "AB", lastSeen: 0 } }
  threads: {},    // { name: [ {who:"user"|"npc", text, gif:{url,title}|null, ts} ] }
  groups: {},     // { groupName: { members: ["Aiden","Maya"], avatar: "GN" } }
  groupThreads: {}, // { groupName: [ {who:"user"|"npc", sender, text, gif:{url,title}|null, ts} ] }
  feed: [],       // [ {id, author, caption, gif:{url,title}|null, tags:[], mentions:[], likes:0, likedByUser:false, comments:[], ts} ]
  discordServers: {}, // { serverName: { icon:"SN", channels: { channelName: [ {author, text, gif:{url,title}|null, isUser, ts} ] } } }
  discordInvites: [], // [ {id, server, from, message, ts} ]
  storiesViewed: {}, // { authorName: timestamp of the latest story that author's viewed up through }
  lastGifSentAt: {}, // { senderName: timestamp of their most recent GIF tag, for rate-limiting }
  notifications: [], // [ {id, type:"follow"|"like"|"comment"|"mention"|"repost", actor, text, postId, ts, read} ] - see pushNotification()
  unread: 0,
  randomCast: [], // names of the procedurally-generated "extras" used to seed/animate the feed - see ensureRandomCast()
  randomFeedSeeded: false, // whether this chat's feed has already been backfilled with an initial batch of random posts
  randomCastTheme: null, // theme key ("contemporary"|"fantasy"|"scifi"|"historical") the background cast was generated in - locked in once set so the same chat's extras don't flip themes mid-story; see resolveCastTheme()
  userAffinity: { authors: {}, tags: {} }, // running tally of how much the user has engaged with each author/tag (likes=1pt, comments=2pt) - powers the "For You" feed ranking, see scorePostForYou()
  userActionLog: [], // timestamps of the user's own likes/comments, trimmed to the last 6h - see userEngagementLevel()
};

// UI/install-level preferences that should stay the same no matter
// which chat is open, so they live in the regular per-extension
// settings store instead of per-chat metadata.
const defaultGlobalSettings = {
  enabled: true,
  togglePos: null, // { left, top } in px once the user has dragged the floating button; null = default corner spot
  panelPos: null, // { left, top } in px once the user has dragged the panel itself; null = auto-follow the button
  gifApiKey: "", // optional user-supplied Klipy API key; GIF/meme features work offline without one
  personaPhoto: "", // data URL for the user's own avatar (shown wherever context.name1 posts/messages), install-wide like the rest of this block
  autoPostsEnabled: true, // let known contacts spontaneously post to the feed on their own, not just via [POST:] tags in a reply
  autoPostFrequency: "normal", // "rare" | "normal" | "often" - see AUTO_POST_FREQUENCIES below
  randomFeedEnabled: true, // backfill a fresh chat's feed with posts from procedurally-generated background profiles
  randomActivityEnabled: true, // let those same background profiles keep posting/liking/commenting/following on their own over time
  randomActivityFrequency: "normal", // "rare" | "normal" | "often" - see RANDOM_ACTIVITY_FREQUENCIES below
  randomCastThemeOverride: "auto", // "auto"|"contemporary"|"fantasy"|"scifi"|"historical" - "auto" reads the current character/scenario to guess a theme; anything else pins every chat's background cast to that theme regardless of setting
  teachTagsEnabled: true, // auto-inject the [TEXT:]/[NUMBER:]/[POST:] etc. tag syntax into every prompt, so characters use the phone without the user having to paste instructions into every character card themselves
};

const CHAT_DATA_KEYS = new Set(Object.keys(defaultChatData));
const GLOBAL_SETTINGS_KEYS = new Set(Object.keys(defaultGlobalSettings));

let chatMetadataWarned = false;

// The live metadata object for whichever chat is currently open. ST
// swaps this out (or its contents) when the user switches chats. If a
// given SillyTavern build doesn't expose it, fall back to storing
// "chat data" alongside the global settings instead of crashing - the
// per-chat separation just won't apply on that build.
function getChatDataStore() {
  if (context.chatMetadata) return context.chatMetadata;
  if (!chatMetadataWarned) {
    chatMetadataWarned = true;
    console.warn(
      "[PhoneUI] context.chatMetadata isn't available on this SillyTavern build; phone data will stay global instead of per-chat."
    );
  }
  return context.extensionSettings;
}

function getGlobalSettings() {
  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = safeClone(defaultGlobalSettings);
  }
  const store = context.extensionSettings[MODULE_NAME];
  for (const key of GLOBAL_SETTINGS_KEYS) {
    if (store[key] === undefined) store[key] = safeClone(defaultGlobalSettings[key]);
  }
  return store;
}

function getChatData() {
  const store = getChatDataStore();
  if (!store[MODULE_NAME]) {
    store[MODULE_NAME] = safeClone(defaultChatData);
  }
  const chatData = store[MODULE_NAME];
  for (const key of CHAT_DATA_KEYS) {
    if (chatData[key] === undefined) chatData[key] = safeClone(defaultChatData[key]);
  }
  return chatData;
}

// Everywhere else in this file just does `getSettings().whatever`, so
// rather than rewrite every call site to know which of the two stores
// (per-chat metadata vs global extension settings) a given field
// lives in, this hands back a thin Proxy that routes each property to
// the right one transparently. Reads/writes of top-level fields (e.g.
// `s.enabled = false`, `s.unread = 0`) and mutations of nested
// objects/arrays (e.g. `s.threads[name].push(...)`) both work exactly
// as if this were one plain object.
function getSettings() {
  const chatData = getChatData();
  const globalSettings = getGlobalSettings();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (CHAT_DATA_KEYS.has(prop)) return chatData[prop];
        if (GLOBAL_SETTINGS_KEYS.has(prop)) return globalSettings[prop];
        return undefined;
      },
      set(_target, prop, value) {
        if (CHAT_DATA_KEYS.has(prop)) {
          chatData[prop] = value;
          return true;
        }
        if (GLOBAL_SETTINGS_KEYS.has(prop)) {
          globalSettings[prop] = value;
          return true;
        }
        return true;
      },
    }
  );
}

function saveSettings() {
  // Global settings (enabled/togglePos/gifApiKey) always live in
  // extension settings.
  context.saveSettingsDebounced();

  // Chat data lives in chat metadata, which uses its own separate
  // save path. Different ST versions expose slightly different
  // function names for this, so try the known options in order and
  // fall back gracefully (worst case, chat data persists on the next
  // autosave instead of immediately) rather than throwing.
  if (typeof context.saveMetadataDebounced === "function") {
    context.saveMetadataDebounced();
  } else if (typeof context.saveMetadata === "function") {
    context.saveMetadata();
  } else if (typeof context.saveChatDebounced === "function") {
    context.saveChatDebounced();
  } else if (typeof context.saveChat === "function") {
    context.saveChat();
  }
  // If none of the above exist, getChatDataStore() already fell back
  // to context.extensionSettings, which the saveSettingsDebounced()
  // call above covers - so data still isn't lost.

  // Keep the AI's standing awareness of feed posts/text threads in
  // sync with whatever just changed. Hooked in here (rather than
  // called individually from every place that touches feed/threads)
  // so it can't silently drift out of date if a future change forgets
  // to call it - anything that persists phone data already calls
  // saveSettings() to persist it, so this always rides along.
  refreshPhoneContextPrompt();
  refreshTagInstructionPrompt();
}

// ---------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------

const TEXT_TAG = /\[TEXT:([^\]]+)\]\s*([^\n\[]+)/g;
const POST_TAG = /\[POST:([^\]]+)\]\s*([^\n\[]+)/g;
const DISCORD_INVITE_TAG = /\[DISCORD_INVITE:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
const DISCORD_MSG_TAG = /\[DISCORD:([^>\]]+)>([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
const NUMBER_TAG = /\[NUMBER:([^\]]+)\]\s*([^\n\[]+)/g;
// [GROUP_START:GroupName:Member1,Member2,...] creates/updates a group
// thread's member list (mirrors DISCORD_INVITE - it's how an NPC
// brings the user into a multi-person thread in the first place).
const GROUP_START_TAG = /\[GROUP_START:([^:\]]+):([^\]]+)\]/g;
// [GROUPTEXT:GroupName:SenderName] message text
const GROUP_TEXT_TAG = /\[GROUPTEXT:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;

// GIF/reaction tags - an NPC can send a GIF the same way a user can
// tap one from the picker. The text after the tag is the Klipy
// search query (e.g. "laughing", "eye roll"), not a caption - it's a
// reaction, same as a quick-tap chip. [POSTGIF] is the exception: it
// can carry an optional caption after a "|".
// [GIF:Name] search query
const GIF_TAG = /\[GIF:([^\]]+)\]\s*([^\n\[]+)/g;
// [GROUPGIF:GroupName:SenderName] search query
const GROUP_GIF_TAG = /\[GROUPGIF:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
// [DISCORDGIF:Server>Channel:SenderName] search query
const DISCORD_GIF_TAG = /\[DISCORDGIF:([^>\]]+)>([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
// [POSTGIF:Name] search query | optional caption
const POST_GIF_TAG = /\[POSTGIF:([^\]]+)\]\s*([^\n\[]+)/g;

// [TEXT_UNKNOWN:PhoneNumber] message text - a text from a number that
// isn't a contact yet. Shows up as a raw-number thread until a
// [NUMBER:Name] tag (or the user manually saving it) resolves it to a
// named contact, at which point the thread history migrates over.
const UNKNOWN_TEXT_TAG = /\[TEXT_UNKNOWN:([^\]]+)\]\s*([^\n\[]+)/g;

// [REPOST:ReposterName:OriginalAuthorName] optional added caption -
// reposts that author's most recent feed post under ReposterName,
// same idea as a retweet/share. Caption is optional (can be empty).
const REPOST_TAG = /\[REPOST:([^:\]]+):([^\]]+)\]([^\n\[]*)/g;

// [FOLLOW:CharacterName] - that character follows the user on social
// media. No trailing text needed, just the tag itself (a bare
// [FOLLOW:Name] with nothing after it on the line is fine).
const FOLLOW_TAG = /\[FOLLOW:([^\]]+)\]/g;
// [LIKE:CharacterName] - that character likes the user's most recent
// feed post. Same bare-tag shape as FOLLOW.
const LIKE_TAG = /\[LIKE:([^\]]+)\]/g;
// [COMMENT:CharacterName] comment text - that character comments on
// the user's most recent feed post.
const COMMENT_TAG = /\[COMMENT:([^\]]+)\]\s*([^\n\[]+)/g;

function extractTagsAndMentions(str) {
  const tags = [...str.matchAll(/#(\w+)/g)].map((m) => m[1]);
  const mentions = [...str.matchAll(/@(\w+)/g)].map((m) => m[1]);
  return { tags, mentions };
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ---------------------------------------------------------------
// Follows & fame - each contact gets an auto-generated follower count
// the first time they're seen, calculated once and then stored (not
// re-rolled on every render). Characters who read as "famous" from
// their character card (or, failing that, just their name) get a
// celebrity-sized count; everyone else gets an ordinary one.
// ---------------------------------------------------------------

// Words that suggest a character is meant to be perceived as famous
// within their own story - a pop star, an actor, a public figure -
// as opposed to an ordinary person the user happens to know. This is
// a plain keyword heuristic (no network calls, no LLM round-trip), so
// it only has to be good enough to make the obviously-famous cards
// feel right; it's flavor for a social app, not a load-bearing sim.
const FAME_KEYWORDS = [
  "famous", "celebrity", "superstar", "megastar", "a-list", "alist",
  "renowned", "world-famous", "world famous", "well-known", "well known",
  "household name", "iconic", "idol", "pop star", "popstar",
  "rock star", "rockstar", "movie star", "film star", "chart-topping",
  "chart topping", "award-winning", "award winning", "grammy", "oscar",
  "platinum-selling", "platinum selling", "billboard chart", "influencer",
  "internet famous", "viral sensation", "media sensation", "tabloid",
  "paparazzi", "millions of fans", "millions of followers", "huge fanbase",
  "sold-out arenas", "sold out arenas", "global icon", "supermodel",
  "socialite", "public figure", "heiress", "royal family", "royalty",
  "billionaire", "magnate", "tycoon",
];

// Best-effort lookup of the actual character card behind a contact
// name, so the fame check can look at their real description/
// personality/tags instead of just the bare name string. Contacts in
// this extension are created from plain names pulled out of chat
// tags, so there's no guaranteed link back to a character object -
// this just does a reasonable case-insensitive name match against
// whatever ST currently has loaded.
function findCharacterCardFor(name) {
  try {
    const list = context?.characters;
    if (!Array.isArray(list)) return null;
    const clean = (name || "").trim().toLowerCase();
    if (!clean) return null;
    return list.find((c) => (c?.name || "").trim().toLowerCase() === clean) || null;
  } catch (e) {
    return null;
  }
}

// "1234" -> "1.2K", "2600000" -> "2.6M". Drops a trailing ".0" so
// round numbers don't show "3.0M" when "3M" reads cleaner.
function formatFollowerCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

// Computed once per contact and cached on the contact object (see
// ensureContact) rather than re-rolled on every render, so a
// character's follower count stays stable for the life of the chat
// instead of jittering around every time the panel redraws.
function computeFollowerStats(name) {
  const card = findCharacterCardFor(name);
  const text = [
    card?.description,
    card?.personality,
    card?.scenario,
    card?.creatorcomment,
    Array.isArray(card?.tags) ? card.tags.join(" ") : "",
    name,
  ]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();

  const famous = FAME_KEYWORDS.some((kw) => text.includes(kw));

  const followerCount = famous
    ? Math.floor(500_000 + Math.random() * 11_500_000) // ~500K - 12M, celebrity range
    : Math.floor(8 + Math.random() * 2_400); // ~8 - 2,400, ordinary-person range

  return { famous, followerCount };
}

function ensureContact(name) {
  const s = getSettings();
  if (!s.contacts[name]) {
    const { famous, followerCount } = computeFollowerStats(name);
    s.contacts[name] = {
      avatar: initials(name),
      lastSeen: Date.now(),
      famous,
      followerCount,
      following: false, // does the USER follow this contact
      followsUser: false, // does this contact follow the USER back
    };
  } else if (s.contacts[name].followerCount === undefined) {
    // Existing contact from before this feature existed - backfill
    // once, same idea as any other lazily-added field in this file.
    const { famous, followerCount } = computeFollowerStats(name);
    s.contacts[name].famous = famous;
    s.contacts[name].followerCount = followerCount;
    if (s.contacts[name].following === undefined) s.contacts[name].following = false;
    if (s.contacts[name].followsUser === undefined) s.contacts[name].followsUser = false;
  }
  return s.contacts[name];
}

// What to actually show in the UI for a contact: their user-set
// nickname if they have one, otherwise "Unknown" for an unresolved
// number, otherwise their real name. The nickname is purely a display
// label - everything that routes messages (thread keys, tag names
// sent back to the model, group membership) keeps using the real
// underlying key, so renaming a contact never breaks the model's own
// sense of who's who.
// Ambient/background contacts (see ensureRandomCast) only clutter the
// Texts and Contacts tabs, where "no messages yet" from 16 strangers
// isn't useful - they're feed flavor, not people the user is actually
// texting. Once there's a real reason to see them there (the user
// followed them, or an actual thread exists - e.g. they replied to a
// story, or the user tapped Message from their profile), they show up
// normally like any other contact.
function visibleContactNames() {
  const s = getSettings();
  return Object.keys(s.contacts).filter((n) => {
    const c = s.contacts[n];
    if (!c?.ambient) return true;
    if (c.following) return true;
    if (s.threads[n]?.length) return true;
    return false;
  });
}

function displayName(key, contact) {
  const c = contact || getSettings().contacts[key];
  if (c?.nickname) return c.nickname;
  if (c?.unknown) return "Unknown";
  return key;
}

// Lets the user set/clear a nickname for any contact - one they've
// been named for by the model, or a number-only contact they haven't
// identified yet. Doesn't touch the contact's real key/number, so
// nothing about how the model addresses them changes.
function setNickname(key) {
  const s = getSettings();
  const contact = s.contacts[key];
  if (!contact) return;
  const current = contact.nickname || "";
  const next = prompt(`Nickname for ${key}:`, current);
  if (next === null) return; // cancelled
  const clean = next.trim();
  contact.nickname = clean || undefined;
  saveSettings();
  renderPanel();
}

// ---------------------------------------------------------------
// Profile pictures - a contact's own photo, and the user's own
// "persona" photo. Both are optional; anywhere an avatar shows up,
// it falls back to the plain initials circle when no photo is set.
// ---------------------------------------------------------------

// Which photo (if any) belongs to a given display name: the user's
// own persona photo if the name is the current persona, otherwise
// that contact's photo. Returns null (not undefined) when there's
// nothing set, so callers can use it directly in a ternary.
function avatarPhotoFor(name) {
  const s = getSettings();
  if (name === (currentPersonaName())) return s.personaPhoto || null;
  return s.contacts[name]?.photo || null;
}

// Renders one avatar circle - an actual photo if `photoUrl` is set,
// otherwise the plain initials/label text exactly like before.
// `extraClass` mirrors the modifier classes the old inline markup
// used (phoneui-avatar-sm, phoneui-groupavatar, etc).
function avatarHtml(label, photoUrl, extraClass = "") {
  const cls = `phoneui-avatar${extraClass ? " " + extraClass : ""}`;
  return photoUrl
    ? `<div class="${cls}"><img class="phoneui-avatarimg" src="${escapeHtml(photoUrl)}" alt="" /></div>`
    : `<div class="${cls}">${escapeHtml(label)}</div>`;
}

// Follower count + Follow/Following button for a given contact,
// shared between the Feed (post header) and Contacts list so both
// stay visually and behaviorally consistent. Returns "" for the
// user's own persona - you can't follow yourself.
function followLineHtml(name) {
  const persona = currentPersonaName();
  if (name === persona) return "";
  const c = ensureContact(name);
  const countLabel = formatFollowerCount(c.followerCount || 0);
  const famousBadge = c.famous
    ? `<i class="fa-solid fa-certificate phoneui-verified" title="Well-known"></i>`
    : "";
  return `<span class="phoneui-followerline">
      ${famousBadge}<span class="phoneui-followercount">${countLabel} followers</span>
    </span>
    <button type="button" class="phoneui-followbtn ${c.following ? "phoneui-following" : ""}" data-follow="${escapeHtml(
    name
  )}">${c.following ? "Following" : "Follow"}</button>`;
}

// Reads a File into a small, storage-friendly data URL: downscales to
// a 160px-max square and re-encodes as JPEG, since profile pictures
// end up saved straight into chat metadata (or global settings, for
// the persona photo) and a full-resolution phone photo would bloat
// that considerably.
function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.onload = () => {
        const maxSide = 160;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Opens a native "choose an image" file picker and resolves to a
// resized data URL, or null if the user cancelled/picked nothing.
// Shared by both the contact-photo and persona-photo pickers below.
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await readImageAsDataUrl(file));
      } catch (e) {
        console.error("[PhoneUI] Couldn't read image:", e);
        alert("Couldn't read that image file.");
        resolve(null);
      }
    });
    input.click();
  });
}

// Lets the user set or replace a contact's profile picture.
async function setContactPhoto(key) {
  const s = getSettings();
  if (!s.contacts[key]) return;
  const dataUrl = await pickImageFile();
  if (!dataUrl) return;
  s.contacts[key].photo = dataUrl;
  saveSettings();
  renderPanel();
}

// Removes a contact's profile picture, reverting them to the plain
// initials avatar.
function removeContactPhoto(key) {
  const s = getSettings();
  if (!s.contacts[key]?.photo) return;
  delete s.contacts[key].photo;
  saveSettings();
  renderPanel();
}

// A contact who's texted from a number that hasn't been tied to a
// name yet - keyed by the raw number itself (both in `contacts` and
// `threads`) instead of a name, so it reads as a stranger's number
// until [NUMBER:Name] or the user's "save as contact" resolves it.
function ensureUnknownContact(number) {
  const s = getSettings();
  const key = number.trim();
  if (!s.contacts[key]) {
    s.contacts[key] = { avatar: "?", lastSeen: Date.now(), phone: key, unknown: true };
  }
  return s.contacts[key];
}

// Folds an unknown-number thread's history into a real, named
// contact - used both when [NUMBER:Name] reveals who an unresolved
// number belongs to, and when the user manually saves one from the
// thread header. Safe no-op if oldKey isn't actually an unknown
// contact.
function resolveUnknownNumber(oldKey, newName, opts = {}) {
  const s = getSettings();
  const clean = (newName || "").trim();
  if (!clean || !s.contacts[oldKey]) return;
  const number = s.contacts[oldKey].phone || oldKey;
  const contact = ensureContact(clean);
  if (!contact.phone) contact.phone = number;
  const oldThread = s.threads[oldKey] || [];
  s.threads[clean] = [...(s.threads[clean] || []), ...oldThread].sort((a, b) => a.ts - b.ts);
  delete s.threads[oldKey];
  delete s.contacts[oldKey];
  if (activeThread === oldKey) activeThread = clean;
  saveSettings();
  renderPanel();
  if (!opts.silent) {
    sendToChat(`[SYSTEM] ${currentPersonaName()} saved ${number} as a contact named "${clean}".`);
  }
}

// ---------------------------------------------------------------
// Block/mute - a blocked contact's incoming TEXT/GIF/GROUPTEXT/
// GROUPGIF/POST/POSTGIF/DISCORD/DISCORDGIF/invite tags are silently
// ignored (logged to console) until unblocked, on top of the
// [SYSTEM] note telling the model to stop texting as that character.
// ---------------------------------------------------------------

function isBlocked(name) {
  const s = getSettings();
  return !!s.contacts[name]?.blocked;
}

function toggleBlock(name) {
  const s = getSettings();
  const contact = ensureContact(name);
  contact.blocked = !contact.blocked;
  saveSettings();
  renderPanel();
  sendToChat(
    contact.blocked
      ? `[SYSTEM] ${currentPersonaName()} has blocked ${name}. ${name} should not send any more texts, group messages, posts, or Discord messages until unblocked.`
      : `[SYSTEM] ${currentPersonaName()} has unblocked ${name}.`
  );
}

// Digits-only comparison so "(555) 019-2847" and "555-019-2847" are
// recognized as the same number regardless of how a model formats it.
function normalizePhone(str) {
  return (str || "").replace(/\D+/g, "");
}

// Bug fix: NUMBER/TEXT_UNKNOWN tags used to accept literally any text
// after the tag as "the number" - a model could hand over "unknown",
// "ask Maya", or a 3-digit typo and the extension would happily save
// it as a contact's phone number. This enforces that what comes
// through actually looks like a real, dialable number (NANP-style:
// 10 digits, or 11 with a leading country code 1) before it's ever
// written into a contact - anything else is rejected the same way a
// real phone's contacts app would reject it. Fictional 555-exchange
// numbers (the README's recommended format) pass this fine, since
// 555 is a normal, valid NXX exchange as far as the shape check goes.
function isValidPhoneNumber(str) {
  let digits = normalizePhone(str);
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return false;
  // NANP area code and exchange code can't start with 0 or 1.
  if (digits[0] === "0" || digits[0] === "1") return false;
  if (digits[3] === "0" || digits[3] === "1") return false;
  // Reject the obvious placeholder patterns a model sometimes falls
  // back on when it hasn't actually generated a number (all the same
  // repeated digit, or straightforward sequential runs).
  if (/^(\d)\1{9}$/.test(digits)) return false;
  return true;
}

// Formats a validated 10-digit number as "(NXX) NXX-XXXX" so numbers
// display consistently in the UI no matter how the model formatted
// the raw tag text.
function formatPhoneNumber(str) {
  let digits = normalizePhone(str);
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return str.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Looks up which contact (other than excludeName) already holds this
// number, so a phone number can only ever be "valid" for the one NPC
// that actually handed it out.
function findContactNameByPhone(number, excludeName) {
  const s = getSettings();
  const target = normalizePhone(number);
  if (!target) return null;
  for (const [name, c] of Object.entries(s.contacts)) {
    if (name === excludeName) continue;
    if (c.phone && normalizePhone(c.phone) === target) return name;
  }
  return null;
}

// Creates a group thread if it doesn't exist yet, and folds in any
// new member names (each becomes a contact too, same as a 1:1 text).
// Safe to call repeatedly - existing members/messages are untouched.
function ensureGroup(groupName, memberNames) {
  const s = getSettings();
  if (!s.groups[groupName]) {
    s.groups[groupName] = { members: [], avatar: initials(groupName) };
  }
  const group = s.groups[groupName];
  for (const raw of memberNames) {
    const clean = raw.trim();
    if (!clean) continue;
    ensureContact(clean);
    if (!group.members.includes(clean)) group.members.push(clean);
  }
  if (!s.groupThreads[groupName]) s.groupThreads[groupName] = [];
  return group;
}

function ensureServer(serverName) {
  const s = getSettings();
  if (!s.discordServers[serverName]) {
    s.discordServers[serverName] = {
      icon: initials(serverName),
      channels: { general: [] },
    };
  }
  return s.discordServers[serverName];
}

function handleIncomingMessage(rawText) {
  if (!rawText) return;
  const s = getSettings();
  let sawSomething = false;
  let sawTyping = false;

  for (const match of rawText.matchAll(TEXT_TAG)) {
    const [, name, text] = match;
    const cleanName = name.trim();
    const cleanText = text.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [TEXT:${cleanName}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanName);
    // Show "typing..." right away; the message itself lands after a
    // short fake delay instead of appearing instantly.
    typingThreads.add(cleanName);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      typingThreads.delete(cleanName);
      const st = getSettings();
      if (!st.threads[cleanName]) st.threads[cleanName] = [];
      st.threads[cleanName].push({ who: "npc", text: cleanText, ts: Date.now() });
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-comment",
        title: displayName(cleanName),
        body: cleanText,
        onOpen: () => {
          activeTab = "texts";
          activeThread = cleanName;
        },
      });
    }, typingDelayFor(cleanText));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(GIF_TAG)) {
    const [, name, query] = match;
    const cleanName = name.trim();
    const cleanQuery = query.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [GIF:${cleanName}] - contact is blocked.`);
      continue;
    }
    if (!canSendNpcGif(cleanName)) {
      console.warn(`[PhoneUI] Ignored [GIF:${cleanName}] - sending too many GIFs too fast.`);
      continue;
    }
    markNpcGifSent(cleanName);
    ensureContact(cleanName);
    typingThreads.add(cleanName);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      resolveGifForQuery(cleanQuery).then((gif) => {
        typingThreads.delete(cleanName);
        const st = getSettings();
        if (!st.threads[cleanName]) st.threads[cleanName] = [];
        st.threads[cleanName].push({
          who: "npc",
          text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
          gif: gif || null,
          ts: Date.now(),
        });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-solid fa-comment",
          title: cleanName,
          body: gif ? "Sent a GIF" : cleanQuery,
          onOpen: () => {
            activeTab = "texts";
            activeThread = cleanName;
          },
        });
      });
    }, typingDelayFor(cleanQuery || "gif"));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(GROUP_START_TAG)) {
    const [, groupName, memberList] = match;
    const cleanGroup = groupName.trim();
    const members = memberList
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const isNew = !s.groups[cleanGroup];
    ensureGroup(cleanGroup, members);
    sawSomething = true;
    if (isNew) {
      notify({
        icon: "fa-solid fa-user-group",
        title: `Added to ${cleanGroup}`,
        body: `With ${members.join(", ")}`,
        onOpen: () => {
          activeTab = "texts";
          activeThread = null;
          activeGroup = cleanGroup;
        },
      });
    }
  }

  for (const match of rawText.matchAll(GROUP_TEXT_TAG)) {
    const [, groupName, senderName, text] = match;
    const cleanGroup = groupName.trim();
    const cleanSender = senderName.trim();
    const cleanText = text.trim();
    // Same rule as Discord: an NPC can't message a group thread the
    // user hasn't been added to yet via GROUP_START. A blocked sender
    // is silently skipped too, same as a 1:1 TEXT would be.
    if (s.groups[cleanGroup] && isBlocked(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPTEXT:${cleanGroup}:${cleanSender}] - contact is blocked.`);
    } else if (s.groups[cleanGroup]) {
      ensureContact(cleanSender);
      if (!typingGroups[cleanGroup]) typingGroups[cleanGroup] = new Set();
      typingGroups[cleanGroup].add(cleanSender);
      sawTyping = true;
      const timerId = setTimeout(() => {
        pendingTypingTimers.delete(timerId);
        typingGroups[cleanGroup]?.delete(cleanSender);
        const st = getSettings();
        if (!st.groups[cleanGroup]) return; // group was removed while we waited
        if (!st.groups[cleanGroup].members.includes(cleanSender)) {
          st.groups[cleanGroup].members.push(cleanSender);
        }
        if (!st.groupThreads[cleanGroup]) st.groupThreads[cleanGroup] = [];
        st.groupThreads[cleanGroup].push({ who: "npc", sender: cleanSender, text: cleanText, ts: Date.now() });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-solid fa-user-group",
          title: cleanGroup,
          body: `${cleanSender}: ${cleanText}`,
          onOpen: () => {
            activeTab = "texts";
            activeThread = null;
            activeGroup = cleanGroup;
          },
        });
      }, typingDelayFor(cleanText));
      pendingTypingTimers.add(timerId);
    }
  }

  for (const match of rawText.matchAll(GROUP_GIF_TAG)) {
    const [, groupName, senderName, query] = match;
    const cleanGroup = groupName.trim();
    const cleanSender = senderName.trim();
    const cleanQuery = query.trim();
    if (!canSendNpcGif(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPGIF:${cleanGroup}:${cleanSender}] - sending too many GIFs too fast.`);
      continue;
    }
    // Same rule as GROUPTEXT - can't land in a group the user hasn't
    // been added to yet, and a blocked sender is skipped.
    if (s.groups[cleanGroup] && isBlocked(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPGIF:${cleanGroup}:${cleanSender}] - contact is blocked.`);
    } else if (s.groups[cleanGroup]) {
      markNpcGifSent(cleanSender);
      ensureContact(cleanSender);
      if (!typingGroups[cleanGroup]) typingGroups[cleanGroup] = new Set();
      typingGroups[cleanGroup].add(cleanSender);
      sawTyping = true;
      const timerId = setTimeout(() => {
        pendingTypingTimers.delete(timerId);
        resolveGifForQuery(cleanQuery).then((gif) => {
          typingGroups[cleanGroup]?.delete(cleanSender);
          const st = getSettings();
          if (!st.groups[cleanGroup]) return; // group was removed while we waited
          if (!st.groups[cleanGroup].members.includes(cleanSender)) {
            st.groups[cleanGroup].members.push(cleanSender);
          }
          if (!st.groupThreads[cleanGroup]) st.groupThreads[cleanGroup] = [];
          st.groupThreads[cleanGroup].push({
            who: "npc",
            sender: cleanSender,
            text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
            gif: gif || null,
            ts: Date.now(),
          });
          st.unread += 1;
          saveSettings();
          renderPanel();
          updateToggleBadge();
          notify({
            icon: "fa-solid fa-user-group",
            title: cleanGroup,
            body: gif ? `${cleanSender} sent a GIF` : `${cleanSender}: ${cleanQuery}`,
            onOpen: () => {
              activeTab = "texts";
              activeThread = null;
              activeGroup = cleanGroup;
            },
          });
        });
      }, typingDelayFor(cleanQuery || "gif"));
      pendingTypingTimers.add(timerId);
    }
  }

  for (const match of rawText.matchAll(POST_TAG)) {
    const [, name, caption] = match;
    const cleanName = name.trim();
    const cleanCaption = caption.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POST:${cleanName}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanName);
    const { tags, mentions } = extractTagsAndMentions(cleanCaption);
    const post = {
      id: crypto.randomUUID(),
      author: cleanName,
      caption: cleanCaption,
      tags,
      mentions,
      likes: Math.floor(Math.random() * 12),
      likedByUser: false,
      views: 0,
      comments: [],
      ts: Date.now(),
    };
    s.feed.unshift(post);
    notifyIfMentionsUser(post);
    sawSomething = true;
    notify({
      icon: "fa-solid fa-images",
      title: `${cleanName} posted`,
      body: cleanCaption,
      onOpen: () => {
        activeTab = "feed";
      },
    });
  }

  for (const match of rawText.matchAll(POST_GIF_TAG)) {
    const [, name, rest] = match;
    const cleanName = name.trim();
    const [queryPart, captionPart] = rest.split("|");
    const cleanQuery = (queryPart || "").trim();
    const cleanCaption = (captionPart || "").trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POSTGIF:${cleanName}] - contact is blocked.`);
      continue;
    }
    if (!canSendNpcGif(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POSTGIF:${cleanName}] - sending too many GIFs too fast.`);
      continue;
    }
    markNpcGifSent(cleanName);
    ensureContact(cleanName);
    resolveGifForQuery(cleanQuery).then((gif) => {
      const st = getSettings();
      const finalCaption = gif
        ? cleanCaption
        : cleanCaption || `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`;
      const { tags, mentions } = extractTagsAndMentions(finalCaption);
      const post = {
        id: crypto.randomUUID(),
        author: cleanName,
        caption: finalCaption,
        gif: gif || null,
        tags,
        mentions,
        likes: Math.floor(Math.random() * 12),
        likedByUser: false,
      views: 0,
        comments: [],
        ts: Date.now(),
      };
      st.feed.unshift(post);
      notifyIfMentionsUser(post);
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-images",
        title: `${cleanName} posted`,
        body: gif ? finalCaption || "Posted a GIF" : finalCaption,
        onOpen: () => {
          activeTab = "feed";
        },
      });
    });
  }

  for (const match of rawText.matchAll(DISCORD_INVITE_TAG)) {
    const [, serverName, fromName, message] = match;
    const cleanServer = serverName.trim();
    const cleanFrom = fromName.trim();
    if (isBlocked(cleanFrom)) {
      console.warn(`[PhoneUI] Ignored [DISCORD_INVITE:${cleanServer}:${cleanFrom}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanFrom);
    s.discordInvites.push({
      id: crypto.randomUUID(),
      server: cleanServer,
      from: cleanFrom,
      message: message.trim(),
      ts: Date.now(),
    });
    sawSomething = true;
    notify({
      icon: "fa-brands fa-discord",
      title: `Invite: ${cleanServer}`,
      body: `${cleanFrom} — ${message.trim()}`,
      onOpen: () => {
        activeTab = "discord";
        activeServer = null;
        activeChannel = null;
      },
    });
  }

  for (const match of rawText.matchAll(DISCORD_MSG_TAG)) {
    const [, serverName, channelName, authorName, text] = match;
    const cleanServer = serverName.trim();
    const cleanChannel = channelName.trim().toLowerCase();
    const cleanAuthor = authorName.trim();
    // Only lands in the server if the user has actually joined it -
    // an NPC can't post into a server the user hasn't accepted yet -
    // and a blocked author is skipped the same way.
    if (s.discordServers[cleanServer] && isBlocked(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORD:${cleanServer}>${cleanChannel}:${cleanAuthor}] - contact is blocked.`);
    } else if (s.discordServers[cleanServer]) {
      const server = s.discordServers[cleanServer];
      if (!server.channels[cleanChannel]) server.channels[cleanChannel] = [];
      server.channels[cleanChannel].push({
        author: cleanAuthor,
        text: text.trim(),
        isUser: false,
        ts: Date.now(),
      });
      sawSomething = true;
      notify({
        icon: "fa-brands fa-discord",
        title: `${cleanAuthor} in #${cleanChannel}`,
        body: text.trim(),
        onOpen: () => {
          activeTab = "discord";
          activeServer = cleanServer;
          activeChannel = cleanChannel;
        },
      });
    }
  }

  for (const match of rawText.matchAll(DISCORD_GIF_TAG)) {
    const [, serverName, channelName, authorName, query] = match;
    const cleanServer = serverName.trim();
    const cleanChannel = channelName.trim().toLowerCase();
    const cleanAuthor = authorName.trim();
    const cleanQuery = query.trim();
    if (!canSendNpcGif(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORDGIF:${cleanServer}>${cleanChannel}:${cleanAuthor}] - sending too many GIFs too fast.`);
      continue;
    }
    // Same rule as DISCORD - can't land in a server the user hasn't
    // joined, and a blocked author is skipped.
    if (s.discordServers[cleanServer] && isBlocked(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORDGIF:${cleanServer}>${cleanChannel}:${cleanAuthor}] - contact is blocked.`);
    } else if (s.discordServers[cleanServer]) {
      markNpcGifSent(cleanAuthor);
      if (!s.discordServers[cleanServer].channels[cleanChannel]) {
        s.discordServers[cleanServer].channels[cleanChannel] = [];
      }
      resolveGifForQuery(cleanQuery).then((gif) => {
        const st = getSettings();
        const server = st.discordServers[cleanServer];
        if (!server) return; // server was removed while we waited
        if (!server.channels[cleanChannel]) server.channels[cleanChannel] = [];
        server.channels[cleanChannel].push({
          author: cleanAuthor,
          text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
          gif: gif || null,
          isUser: false,
          ts: Date.now(),
        });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-brands fa-discord",
          title: `${cleanAuthor} in #${cleanChannel}`,
          body: gif ? "Sent a GIF" : cleanQuery,
          onOpen: () => {
            activeTab = "discord";
            activeServer = cleanServer;
            activeChannel = cleanChannel;
          },
        });
      });
    }
  }

  for (const match of rawText.matchAll(NUMBER_TAG)) {
    const [, name, number] = match;
    const cleanName = name.trim();
    const rawNumber = number.trim();
    // Bug fix: a [NUMBER:Name] tag used to be accepted no matter what
    // followed it, so a malformed or placeholder "number" from the
    // model would still get written into that character's contact
    // card. Require something that actually looks like a real,
    // dialable number before it's treated as valid - anything else is
    // dropped, same as the rest of a bad tag would be.
    if (!isValidPhoneNumber(rawNumber)) {
      console.warn(
        `[PhoneUI] Ignored [NUMBER:${cleanName}] "${rawNumber}" - not a valid-looking phone number.`
      );
      continue;
    }
    const cleanNumber = formatPhoneNumber(rawNumber);
    // A number belongs exclusively to whichever NPC first hands it
    // over - it's only ever "valid" for the contact that actually
    // provided it. If some other character's tag shows up with a
    // number already claimed by someone else, ignore it instead of
    // letting them steal/overwrite that contact's number.
    const claimedBy = findContactNameByPhone(cleanNumber, cleanName);
    if (claimedBy && s.contacts[claimedBy]?.unknown) {
      // An unresolved "unknown number" thread just got a name - fold
      // its history into the real contact instead of treating this as
      // a clash the way an already-named contact's number would be.
      resolveUnknownNumber(claimedBy, cleanName, { silent: true });
    } else if (claimedBy) {
      console.warn(
        `[PhoneUI] Ignored [NUMBER:${cleanName}] ${cleanNumber} - already assigned to ${claimedBy}.`
      );
      continue;
    }
    const contact = ensureContact(cleanName);
    const isNew = contact.phone !== cleanNumber;
    contact.phone = cleanNumber;
    sawSomething = true;
    if (isNew) {
      notify({
        icon: "fa-solid fa-address-card",
        title: `${displayName(cleanName)} shared their number`,
        body: cleanNumber,
        onOpen: () => {
          activeTab = "contacts";
        },
      });
    }
  }

  for (const match of rawText.matchAll(UNKNOWN_TEXT_TAG)) {
    const [, number, text] = match;
    const rawNumber = number.trim();
    const cleanText = text.trim();
    // Same "must actually look like a phone number" rule as NUMBER -
    // a stranger's thread should still be keyed by something that
    // could plausibly be dialed, not arbitrary tag text.
    if (!isValidPhoneNumber(rawNumber)) {
      console.warn(
        `[PhoneUI] Ignored [TEXT_UNKNOWN:${rawNumber}] - not a valid-looking phone number.`
      );
      continue;
    }
    const cleanNumber = formatPhoneNumber(rawNumber);
    ensureUnknownContact(cleanNumber);
    typingThreads.add(cleanNumber);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      typingThreads.delete(cleanNumber);
      const st = getSettings();
      if (!st.threads[cleanNumber]) st.threads[cleanNumber] = [];
      st.threads[cleanNumber].push({ who: "npc", text: cleanText, ts: Date.now() });
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-comment",
        title: "Unknown number",
        body: cleanText,
        onOpen: () => {
          activeTab = "texts";
          activeThread = cleanNumber;
          activeGroup = null;
        },
      });
    }, typingDelayFor(cleanText));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(REPOST_TAG)) {
    const [, reposterName, originalAuthorName, captionRaw] = match;
    const cleanReposter = reposterName.trim();
    const cleanOriginalAuthor = originalAuthorName.trim();
    const cleanCaption = (captionRaw || "").trim();
    if (isBlocked(cleanReposter)) {
      console.warn(`[PhoneUI] Ignored [REPOST:${cleanReposter}:${cleanOriginalAuthor}] - contact is blocked.`);
      continue;
    }
    // Reposts the target author's most recent feed post (s.feed is
    // newest-first, so the first match is the latest one).
    const source = s.feed.find((p) => p.author.toLowerCase() === cleanOriginalAuthor.toLowerCase());
    if (!source) {
      console.warn(
        `[PhoneUI] Ignored [REPOST:${cleanReposter}:${cleanOriginalAuthor}] - no post from ${cleanOriginalAuthor} found to repost.`
      );
      continue;
    }
    ensureContact(cleanReposter);
    // Reposting a repost points back at the original, not the repost.
    const src = source.repostOf || source;
    const { tags, mentions } = extractTagsAndMentions(cleanCaption);
    const repost = {
      id: crypto.randomUUID(),
      author: cleanReposter,
      caption: cleanCaption,
      tags,
      mentions,
      likes: Math.floor(Math.random() * 6),
      likedByUser: false,
      views: 0,
      comments: [],
      ts: Date.now(),
      repostOf: { id: src.id, author: src.author, caption: src.caption, gif: src.gif || null },
    };
    s.feed.unshift(repost);
    notifyIfMentionsUser(repost);
    sawSomething = true;
    notify({
      icon: "fa-solid fa-retweet",
      title: `${cleanReposter} reposted`,
      body: `${src.author}: ${src.caption || "a post"}`,
      onOpen: () => {
        activeTab = "feed";
      },
    });
  }

  for (const match of rawText.matchAll(FOLLOW_TAG)) {
    const [, name] = match;
    const cleanName = name.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [FOLLOW:${cleanName}] - contact is blocked.`);
      continue;
    }
    const contact = ensureContact(cleanName);
    if (contact.followsUser) continue; // already following, nothing new to announce
    contact.followsUser = true;
    pushNotification("follow", cleanName);
  }

  for (const match of rawText.matchAll(LIKE_TAG)) {
    const [, name] = match;
    const cleanName = name.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [LIKE:${cleanName}] - contact is blocked.`);
      continue;
    }
    const persona = currentPersonaName();
    const targetPost = s.feed.find((p) => p.author === persona);
    if (!targetPost) {
      console.warn(`[PhoneUI] Ignored [LIKE:${cleanName}] - the user hasn't posted anything yet.`);
      continue;
    }
    ensureContact(cleanName);
    if (!targetPost.likedBy) targetPost.likedBy = [];
    if (targetPost.likedBy.includes(cleanName)) continue; // already liked it, don't double-count
    targetPost.likedBy.push(cleanName);
    targetPost.likes += 1;
    pushNotification("like", cleanName, { postId: targetPost.id });
  }

  for (const match of rawText.matchAll(COMMENT_TAG)) {
    const [, name, text] = match;
    const cleanName = name.trim();
    const cleanText = text.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [COMMENT:${cleanName}] - contact is blocked.`);
      continue;
    }
    const persona = currentPersonaName();
    const targetPost = s.feed.find((p) => p.author === persona);
    if (!targetPost) {
      console.warn(`[PhoneUI] Ignored [COMMENT:${cleanName}] - the user hasn't posted anything yet.`);
      continue;
    }
    ensureContact(cleanName);
    targetPost.comments.push({ author: cleanName, text: cleanText, ts: Date.now() });
    pushNotification("comment", cleanName, { text: cleanText, postId: targetPost.id });
  }

  if (sawSomething) {
    s.unread += 1;
    saveSettings();
  }
  // Typing dots should appear immediately even though nothing's been
  // saved yet - they're transient UI state, not chat data.
  if (sawSomething || sawTyping) {
    renderPanel();
    updateToggleBadge();
  }
}

// ---------------------------------------------------------------
// Autonomous feed posts
//
// Until now a character could only post to the feed via a [POST:]
// tag included in an actual chat reply - meaning it only ever
// happened as a side effect of the user messaging that character.
// This adds real spontaneous posting: on a timer, with some
// probability per tick (see AUTO_POST_FREQUENCIES), a random contact
// the user has already interacted with is asked - via
// generateQuietPrompt, the same "background generation" API ST's own
// translation/summary features use - to write one short post as
// themselves. The response never touches the visible chat; it's
// parsed the same way an incoming [POST:] tag would be and pushed
// straight into the feed.
// ---------------------------------------------------------------

const AUTO_POST_FREQUENCIES = {
  // Values are the chance, each minute, that a post gets attempted.
  // Independent per-minute coin flips average out to roughly:
  //   rare   -> ~1 attempt every 20 min
  //   normal -> ~1 attempt every 8 min
  //   often  -> ~1 attempt every 4 min
  // "Attempt" (not "post"): most ticks do nothing at all, and an
  // attempt can still be skipped (e.g. no contacts yet) or fail.
  rare: 0.05,
  normal: 0.12,
  often: 0.25,
};
const AUTO_POST_TICK_MS = 60 * 1000;

// Shared by the [POST:] tag handler's job (an AI reply mentioning a
// post) and the autonomous version below (a background generation
// with no chat message at all) so both land in the feed the exact
// same way - blocked check, contact creation, tags/mentions,
// notification - instead of two slightly-different copies of this
// logic drifting apart over time.
function pushFeedPost(rawName, rawCaption) {
  const cleanName = (rawName || "").trim();
  const cleanCaption = (rawCaption || "").trim();
  if (!cleanName || !cleanCaption) return false;
  if (isBlocked(cleanName)) {
    console.warn(`[PhoneUI] Skipped an auto-post from ${cleanName} - contact is blocked.`);
    return false;
  }
  const s = getSettings();
  ensureContact(cleanName);
  const { tags, mentions } = extractTagsAndMentions(cleanCaption);
  const post = {
    id: crypto.randomUUID(),
    author: cleanName,
    caption: cleanCaption,
    tags,
    mentions,
    likes: Math.floor(Math.random() * 12),
    likedByUser: false,
      views: 0,
    comments: [],
    ts: Date.now(),
  };
  s.feed.unshift(post);
  notifyIfMentionsUser(post);
  s.unread += 1;
  saveSettings();
  renderPanel();
  updateToggleBadge();
  notify({
    icon: "fa-solid fa-images",
    title: `${cleanName} posted`,
    body: cleanCaption,
    onOpen: () => {
      activeTab = "feed";
    },
  });
  return true;
}

// Shared by every code path that calls context.generateQuietPrompt
// (autonomous character posts, ambient posts/comments, comment
// replies) so at most one quiet generation is ever in flight at once -
// SillyTavern's generation pipeline isn't meant to run two of these
// concurrently.
let quietGenerationInFlight = false;

// Reads the actual roleplay cast straight from SillyTavern - the
// group's members if this is a group chat, or the single active
// character otherwise - rather than only the names the phone UI
// already happens to have a contact card for. This is what lets a
// character auto-post the first time, before the user has texted
// them or an AI reply has ever tagged them with [POST:]/[TEXT:].
function getRoleplayCastNames() {
  const names = new Set();
  try {
    if (context?.groupId && Array.isArray(context?.groups) && Array.isArray(context?.characters)) {
      const group = context.groups.find((g) => g.id === context.groupId);
      if (group && Array.isArray(group.members)) {
        for (const memberAvatar of group.members) {
          const char = context.characters.find((c) => c.avatar === memberAvatar);
          if (char?.name) names.add(char.name);
        }
      }
    } else if (context?.name2) {
      names.add(context.name2);
    }
  } catch (e) {
    console.warn("[PhoneUI] Couldn't read the current roleplay cast from SillyTavern context.", e);
  }
  return names;
}

async function attemptAutoPost() {
  const s = getSettings();
  if (!s.enabled || !s.autoPostsEnabled) return;
  if (quietGenerationInFlight) return; // don't overlap with a call still in flight
  if (typeof context?.generateQuietPrompt !== "function") return; // feature-detected once per tick, see startAutoPostTimer's warning below

  // Pool is the union of: every character actually in this roleplay
  // right now (group members, or the one active character in a 1:1
  // chat) plus any contact the phone already knows about (e.g. a side
  // character an earlier reply mentioned via [TEXT:]/[POST:]). Unlike
  // before, a character doesn't need to already be a saved contact to
  // be eligible - pushFeedPost() below creates the contact card for
  // them the first time they post, same as a manual [POST:] tag would.
  const persona = currentPersonaName();
  const knownNames = Object.keys(s.contacts).filter(
    (n) => !isBlocked(n) && !s.contacts[n]?.unknown && !s.contacts[n]?.ambient
  );
  const pool = new Set(knownNames);
  for (const n of getRoleplayCastNames()) {
    if (n !== persona && !isBlocked(n)) pool.add(n);
  }
  const names = Array.from(pool);
  if (!names.length) return;
  const name = names[Math.floor(Math.random() * names.length)];

  quietGenerationInFlight = true;
  try {
    const prompt =
      `Write ONE short, natural social-media post as ${name}, in character, spontaneously - ` +
      `something they'd share unprompted (a thought, a moment from their day, a feeling), based on ` +
      `who they are and how the story has gone so far. Reply with ONLY a single line in exactly this ` +
      `format and nothing else, no narration or commentary: [POST:${name}] the post's caption text`;
    const raw = await context.generateQuietPrompt({ quietPrompt: prompt });
    const text = (typeof raw === "string" ? raw : raw?.text || raw?.message || "").trim();
    if (!text) return;

    POST_TAG.lastIndex = 0;
    const match = POST_TAG.exec(text);
    if (match) {
      pushFeedPost(match[1], match[2]);
    } else {
      // Model didn't follow the tag format - fall back to treating
      // the whole (trimmed, de-quoted) reply as the caption rather
      // than silently discarding a perfectly usable post.
      const fallbackCaption = text.replace(/^["“]|["”]$/g, "").trim();
      if (fallbackCaption.length > 0 && fallbackCaption.length <= 300) {
        pushFeedPost(name, fallbackCaption);
      }
    }
  } catch (e) {
    console.warn("[PhoneUI] Autonomous post attempt failed.", e);
  } finally {
    quietGenerationInFlight = false;
  }
}

let autoPostTimerId = null;
let autoPostUnsupportedWarned = false;

function startAutoPostTimer() {
  if (autoPostTimerId) return; // already running
  autoPostTimerId = setInterval(() => {
    const s = getSettings();
    if (!s.enabled || !s.autoPostsEnabled) return;
    if (typeof context?.generateQuietPrompt !== "function") {
      if (!autoPostUnsupportedWarned) {
        autoPostUnsupportedWarned = true;
        console.warn(
          "[PhoneUI] Autonomous feed posts are on, but this SillyTavern build doesn't expose generateQuietPrompt - disabling this tick's attempt. Manual [POST:] tags in chat still work fine."
        );
      }
      return;
    }
    const chance = AUTO_POST_FREQUENCIES[s.autoPostFrequency] ?? AUTO_POST_FREQUENCIES.normal;
    if (Math.random() < chance) attemptAutoPost();
  }, AUTO_POST_TICK_MS);
}

// ---------------------------------------------------------------
// Random / ambient feed content
//
// Everything above this point only ever puts something in the Feed
// because of an actual character - a [POST:] tag, or attemptAutoPost
// asking the LLM to write one. That means a brand new chat opens to a
// completely empty feed, and it stays quiet until you've actually
// talked to someone. This section fills that gap with a large
// recurring cast of procedurally-generated "extras" - background
// profiles with no character card behind them at all - so the feed
// reads like a real, lived-in social app from the moment it opens,
// and keeps getting new posts/likes/comments/follows over time on its
// own. It's entirely synthetic (no LLM calls, same spirit as the
// offline GIF library) so it works instantly with zero setup.
// ---------------------------------------------------------------

const RANDOM_CAST_SIZE = 3000;

const RANDOM_FIRST_NAMES = [
  "Jordan", "Casey", "Riley", "Morgan", "Avery", "Quinn", "Sage", "Rowan",
  "Skyler", "Emerson", "Dakota", "Reese", "Kai", "Micah", "Nova", "Wren",
  "Harlow", "Blair", "Marlowe", "Indigo", "Phoenix", "River", "Ellis", "Tatum",
  "Shiloh", "Remy", "Ari", "Lennox", "Briar", "Wynn", "Maya", "Leo", "Zara",
  "Owen", "Nadia", "Theo", "Priya", "Elias", "Simone", "Miles", "Camille",
  "Noah", "Talia", "Julian", "Rosa", "Amir", "Ivy", "Diego", "Freya", "Malik",
  "Selene", "Oscar", "Layla", "Felix", "Yara", "Gideon", "Mabel", "Sebastian",
  "Aiyana", "Cyrus", "Odette", "Tobias", "Winnie", "Nikolai", "Estelle",
  "Kofi", "Junia", "Mateo", "Petra", "Silas", "Anya", "Emiliano", "Faye",
  "Ronan", "Zoya", "August", "Delphine", "Hendrix", "Marisol", "Callum",
  "Noor", "Beckett", "Adaeze", "Gustav", "Rhiannon", "Ezra", "Suki", "Dashiell",
  "Amara", "Lucian", "Bodhi", "Colette", "Ishaan", "Marguerite",
  // Extra names so a cast this size doesn't lean on the same handful
  // of first/last-name combinations too heavily.
  "Aster", "Bellamy", "Cove", "Darcy", "Elowen", "Fable", "Greer", "Halcyon",
  "Iris", "Jules", "Kestrel", "Linden", "Marnie", "Niamh", "Onyx", "Perrin",
  "Quill", "Roux", "Sable", "Talon", "Ursa", "Vesper", "Wilder", "Xiomara",
  "Yusuf", "Zephyr", "Adalyn", "Baron", "Calder", "Dune", "Esme", "Finch",
  "Giselle", "Hollis", "Idris", "Jael", "Kian", "Lior", "Mireille", "Niall",
  "Opal", "Pax", "Quinta", "Rhys", "Soren", "Thea", "Umeko", "Vale",
  "Waverly", "Xander", "Yolanda", "Zeke", "Anais", "Beau", "Cleo", "Django",
  "Enzo", "Farrah", "Gael", "Hazel", "Imani", "Jasper", "Keiko", "Lior",
  "Mira", "Neve", "Osric", "Pia", "Quest", "Rune", "Senna", "Tomasz",
  "Ulla", "Vada", "Winnifred", "Xenia", "Yara", "Zion", "Abraxas", "Briony",
  "Corvin", "Delfina", "Eamon", "Fira", "Gwen", "Haruki", "Ilse", "Jonas",
  "Keturah", "Lior", "Moray", "Naima", "Oisin", "Pearl", "Quinlan", "Roisin",
  "Solveig", "Tarek", "Una", "Vivienne", "Willa", "Ximena", "Yannick", "Zola",
];
const RANDOM_LAST_NAMES = [
  "Reyes", "Chen", "Okafor", "Bennett", "Nakamura", "Silva", "Patel", "Novak",
  "Larsen", "Whitfield", "Alvarado", "Kowalski", "Delgado", "Brennan", "Hollis",
  "Vance", "Marsh", "Iyer", "Costa", "Fontaine", "Abara", "Renner", "Solis",
  "Meyer", "Vargas", "Kwan", "Ostrander", "Pruitt", "Dumont", "Ekwueme",
  "Whitaker", "Beaumont", "Sato", "Alcazar", "Grimaldi", "Nkemelu", "Falk",
  "Marchetti", "Odom", "Barros", "Fournier", "Castellano", "Adeyemi", "Voss",
  "Petrov", "Villanueva", "Hutton", "Osei", "Laurent", "Bergstrom", "Cabrera",
  "Yamada", "Duarte", "Winslow", "Achebe", "Kessler", "Rousseau", "Okonkwo",
  "Byrne", "Salvatore", "Mbeki", "Landry", "Havel", "Espinoza", "Tremblay",
  "Amadi", "Foss", "Correia", "Baptiste", "Dvorak", "Nwosu", "Halvorsen",
  "Escobar", "Lindqvist", "Bassett", "Oyelaran", "Marchand", "Sokolov",
  "Herrera", "Kaminski", "Odukoya", "Beaulieu", "Rask", "Trujillo", "Anand",
  "Gallo", "Ferreira", "Nassar", "Whitcombe", "Adekunle", "Bergeron",
  // Extra names so a cast this size doesn't lean on the same handful
  // of first/last-name combinations too heavily.
  "Abbasi", "Bianchi", "Castro", "Dahl", "Ekstrom", "Farah", "Giordano",
  "Haddad", "Ibsen", "Jansen", "Kaur", "Lindberg", "Moreau", "Nakashima",
  "Obi", "Petit", "Quintero", "Rahman", "Sarkozy", "Tanaka", "Ueda",
  "Valdez", "Weiss", "Xu", "Yilmaz", "Zamora", "Adamou", "Blackwood",
  "Chowdhury", "Doyle", "Ellison", "Farrow", "Girard", "Holt", "Ionescu",
  "Jaworski", "Kessing", "Lachance", "Mbatha", "Neal", "Oduya", "Pemberton",
  "Quirke", "Redding", "Stavros", "Thibault", "Ude", "Vukovic", "Wren",
  "Xiong", "Yeboah", "Zilberman", "Aldana", "Boucher", "Carrington", "Deacon",
  "Ericson", "Farkas", "Gonzalez", "Hirano", "Isayev", "Jamison", "Kalinowski",
  "Lefebvre", "Mercado", "Nystrom", "Oyelaran", "Prescott", "Quiroga",
  "Rademaker", "Suarez", "Torvik", "Utomo", "Vellacott", "Winters",
];
const RANDOM_BIOS = [
  "coffee enthusiast · plant parent 🌱", "just here for the vibes",
  "professional overthinker", "collecting hobbies like they're trading cards",
  "trying to text back faster this year", "small dog, big opinions",
  "currently obsessed with sourdough", "chronic playlist maker",
  "will talk about my dreams for way too long", "here for the food pics mostly",
  "probably outside", "night owl, forever tired",
  "amateur astronomer, professional snacker",
  "still figuring it out, one post at a time", "photos are 90% my dog",
  "sending good vibes only ✨", "self-appointed local weather correspondent",
  "will unironically recommend you a podcast", "houseplants outnumber my friends",
  "professional napper, amateur everything else", "collector of weird little rocks",
  "here for the memes and the comments section", "trying (and failing) to eat more vegetables",
  "will absolutely talk your ear off about my hobby", "just moved, still finding the light switches",
  "semi-retired from drama, fully retired from small talk", "chaotic good energy only",
  "my personality is mostly playlists at this point", "learning to cook, results vary wildly",
  "professional overpacker for a two-day trip",
];
// A "{mention}" token gets swapped for "@" + another cast member's
// name (or the user, occasionally) - see generateRandomCaption/
// generateRandomCommentText below.
const RANDOM_POST_TEMPLATES = [
  "just had the best coffee of my life ☕ #mondaymood",
  "rearranged my whole room and now I don't recognize my life #glowup",
  "homemade pasta night 🍝 who's coming over",
  "tried a new ramen spot downtown, genuinely life-changing #ramen",
  "sunset from the balcony hits different tonight 🌅",
  "road trip playlist is unmatched right now #roadtrip",
  "why is adulting so expensive lol #relatable",
  "me pretending I have my life together #mood",
  "my cat knocked my phone off the desk mid-scroll, thanks I guess #catsoftheinternet",
  "small steps still count. proud of myself today #growth",
  "finally submitted that project, going to sleep for a week #donezo",
  "rainy days = best writing days ☔",
  "finally beat that level I've been stuck on for a week 🎮",
  "this song has been on repeat all day 🎶 #nowplaying",
  "reorganized my bookshelf by color and I have never felt more powerful",
  "public service announcement: iced coffee in winter is valid #hillIwilldieon",
  "{mention} we need to hang out soon, it's been way too long",
  "just recommended {mention}'s favorite show to literally everyone I know",
  "okay {mention} was right, this place is actually incredible",
  "three cups of tea deep and still not emotionally ready for tomorrow",
  "started a new hobby, give it two weeks before I abandon it #chaotic",
  "walked way too many miles today for absolutely no reason, love that for me",
  "current mood: soft blanket, bad reality tv, zero regrets",
  "does anyone else talk to their plants or is that just me 🌿",
  "found my old journal from high school, we are NOT reading that out loud",
  "cooked something new and it actually turned out good??? shocked #win",
  "woke up at 6am on purpose, felt very powerful about it for exactly one hour",
  "grocery store playlist had me feeling like the main character today",
  "burnt the toast, ate it anyway, no regrets #breakfastofchampions",
  "spent the whole weekend doing absolutely nothing and it was perfect",
  "finally organized my camera roll, found photos I forgot existed",
  "trying a no-spend week, day one going surprisingly well",
  "someone parked their bike right in front of my door again lol love that",
  "the farmers market had the best peaches today, life is good",
  "{mention} sent me the funniest video and I haven't recovered",
  "reading in the park all afternoon, this is the whole personality now",
  "new haircut, feeling unreasonably confident about it",
  "the wifi went out for an hour and I remembered what silence sounds like",
  "made it through the whole grocery list without buying snacks, growth",
  "watched the sunrise on accident because I never went to sleep #worthit",
];
const RANDOM_COMMENT_TEMPLATES = [
  "😂😂😂", "this is so real", "no bc same", "wait this is actually so good",
  "the way I felt this", "okay but why is this so accurate 😭",
  "I need this energy", "stealing this idea ngl", "🔥🔥🔥", "same tbh",
  "this made my day", "couldn't be me lol", "okay but valid fr",
  "the accuracy though 💀", "need this in my life", "this is everything",
  "{mention} we're doing this next weekend", "tagging {mention} bc this is so them",
  "wait I'm actually obsessed with this", "no because I felt this in my soul",
  "this is the content I signed up for", "screaming crying throwing up (happy)",
  "the way you always post the best stuff", "okay this is sending me",
  "certified banger, no notes", "not me saving this for later",
  "{mention} we need this energy", "this unlocked a core memory",
];


// ---------------------------------------------------------------
// Cast themes
//
// The pools above are the "contemporary" theme - present-day names,
// slang, and everyday post topics. That reads fine for a modern-day
// chat, but it's tonally wrong for a story set somewhere else (a
// medieval kingdom, a space colony, a Victorian drawing room) - a
// background post about "iced coffee in winter" breaks immersion in
// a throne room. Each additional theme below swaps in its own name
// pools, bios, and post/comment templates so the background cast
// reads like it belongs in the same world as the actual story.
const FANTASY_FIRST_NAMES = [
  "Aldric", "Branwen", "Caelum", "Doran", "Elowyn", "Fenwick", "Gwyneth",
  "Hadrian", "Isolde", "Joran", "Kael", "Liora", "Maelis", "Nyra", "Orin",
  "Perrin", "Quorra", "Rhoswen", "Sylas", "Tamsin", "Ulric", "Vaelith",
  "Ysolde", "Zephyrine", "Aeric", "Brielle", "Corvin", "Daeva", "Eamon",
  "Fiora", "Gareth", "Halwen", "Ithil", "Jareth", "Kestrel", "Lysandra",
  "Merrin", "Nolwen", "Osric", "Piera", "Quillon", "Ravyn", "Seraphine",
  "Torvald", "Una", "Vesper", "Wyndam", "Xanthe", "Yorick", "Zara",
  "Aldous", "Briar", "Calanthe", "Dorian", "Elric", "Faelan", "Grimwald",
  "Halcyon", "Iolanthe", "Jorund", "Kaelith", "Lyra", "Maren", "Norwyn",
  "Oswyth", "Petra", "Quenna", "Roric", "Selwyn", "Thalia", "Ulfric",
  "Vanwyck", "Wystan", "Xylia", "Yestin", "Zorion", "Aveline", "Bram",
  "Cedric", "Delphine", "Edrin", "Fenna", "Galewyn", "Hollis", "Isengrim",
  "Junia", "Kendrick", "Loreena", "Mabrick", "Neriad", "Oberyn", "Percival",
  "Quintara", "Rowena",
];
const FANTASY_LAST_NAMES = [
  "Stormrune", "Ashvale", "Blackthorn", "Ravenshade", "Ironwood",
  "Nightshade", "Emberfall", "Frostwind", "Silverleaf", "Moonwhisper",
  "Thistledown", "Wolfsbane", "Dawnbringer", "Duskmere", "Hollowmere",
  "Wintershade", "Stonefist", "Brightwater", "Grimhold", "Fairwind",
  "Oakenshield", "Deepwood", "Highmoor", "Wyrmsbane", "Shadowmere",
  "Goldleaf", "Farrowmere", "Windrider", "Blackwood", "Sunderland",
  "Ashwood", "Vaelmoor", "Hearthstone", "Nightfall", "Redmane",
  "Thornfield", "Stormcaller", "Longshadow", "Fireheart", "Greymantle",
  "Whitehollow", "Ravensworth", "Ironhelm", "Larkspur", "Mistwood",
  "Cinderfall", "Hollowbrook", "Wyldwood", "Amberfell", "Duskwright",
  "Fellhaven", "Grovemont", "Steelbrook", "Thornwick", "Wraithmoor",
  "Sablewind", "Glimmerhall", "Rookmire", "Starfell", "Vaelthorne",
  "Windmere", "Ashcombe", "Blightwood", "Ebonshade", "Foxglove",
  "Graystone", "Hallowmere", "Ivythorn", "Larkwood", "Mournhollow",
  "Nettlefield", "Ostravar", "Pinevale", "Quickwater", "Ravencrest",
  "Stagshollow", "Thistlewick", "Umbermoor", "Vesperfield", "Wyrmwood",
];
const FANTASY_POST_TEMPLATES = [
  "the tavern's mead this moon is unusually good, come see for yourself",
  "market day again already?? my coin purse cannot survive this",
  "swore off dueling last winter, then someone insulted my cooking today",
  "the harvest festival preparations are chaos, as always #harvestmoon",
  "finally repaired my armor after the last skirmish, feels good as new",
  "the road north was crawling with bandits, made it through fine though",
  "apprenticed under the new alchemist, my robes already smell of sulfur",
  "the bard at the Crooked Boar sang a ballad about a dragon that never showed up",
  "traded my old blade for a proper one at the smithy, worth every coin",
  "third time this month the well's run dry, someone needs to speak to the miller",
  "spotted lights over the old ruins again last night, no one believes me",
  "spent the whole day mending fences after the storm blew through #farmlife",
  "the guildmaster finally gave me a real contract, wish me luck",
  "{mention} owes me a drink after that wager last night",
  "training with the sword master again, my arms feel like jelly",
  "the caravan finally arrived with spices from the eastern reaches",
  "{mention} nearly got us thrown out of the inn with that story",
  "found an old coin buried near the orchard, wonder whose it was",
  "the moon's been strange these past few nights, the elders are muttering about omens",
  "spent my last coin on a charm from the herbalist, hope it actually works",
  "the castle guard doubled the watch again, something's got them nervous",
  "finally finished the tapestry I've been weaving all season",
  "{mention} dragged me to the archery contest, came in dead last, no regrets",
  "the miller's daughter makes the best bread in the whole village, fight me",
  "camped under the stars past the old bridge, best sleep I've had in weeks",
  "the new stablehand let the goats loose again, chaos in the square",
  "sharpened every blade in the armory today, my hands are numb",
  "the pilgrims passing through say the roads south are safer this season",
  "won a round of dice against the blacksmith, still can't believe it",
  "the healer says I'll be back on my feet by the next full moon",
];
const FANTASY_COMMENT_TEMPLATES = [
  "well met, friend", "ha! this is why I keep you around",
  "the gods have blessed this post", "by the old roads, this is true",
  "{mention} we're telling this tale at the tavern tonight",
  "spoken like a true adventurer", "this deserves a toast",
  "aye, couldn't have said it better", "the bards will sing of this",
  "{mention} you'll never live this one down", "a fine tale indeed",
  "this is why I follow you", "haha, sounds about right for you",
  "may your road stay safe after this one", "well, that explains the noise last night",
];
const SCIFI_FIRST_NAMES = [
  "Vex", "Nyla", "Corin", "Aris", "Ilyana", "Dax", "Sera", "Tobin", "Mira",
  "Kell", "Zara", "Orin", "Yuki", "Theron", "Ansel", "Priyaka", "Juno",
  "Lex", "Rhea", "Soren", "Elix", "Nadira", "Cassian", "Vesper", "Ophira",
  "Marcus", "Talis", "Kira", "Draven", "Iona", "Ash", "Petra", "Ronan",
  "Suri", "Baxton", "Wren", "Xu", "Amos", "Isolde", "Callum", "Nova",
  "Enzo", "Freya", "Gideon", "Halo", "Ines", "Jax", "Kaida", "Lior",
  "Moss", "Nix", "Ozzy", "Piri", "Quill", "Riven", "Sasha", "Tyrell",
  "Umeko", "Vale", "Wick", "Xena", "Yara", "Zeph", "Adric", "Brix",
  "Ceres", "Delta", "Echo", "Faro", "Gale", "Halcyon", "Ivo", "Jinx",
  "Koa", "Lumen", "Mako", "Neva", "Onyx", "Pax", "Quasar", "Roux",
  "Saoirse", "Talon", "Ura", "Vantage", "Wisp", "Xander", "Ylva", "Zed",
];
const SCIFI_LAST_NAMES = [
  "Vantis", "Kestrel-7", "Marrow", "Okoye", "Winters", "Halvard", "Reyes",
  "Chen-Marsh", "Voss", "Idris", "Naidu", "Wren", "Osei", "Falkner",
  "Iyer", "Solano", "Petrova", "Danesh", "Umeh", "Larkin", "Moreno",
  "Adisa", "Brandt", "Corva", "Delacroix", "Ekwe", "Farrow", "Grimes",
  "Halstead", "Isaacs", "Jarrah", "Kessler", "Loche", "Mbeki", "Nkosi",
  "Obuya", "Prewitt", "Quon", "Rask", "Suvari", "Tanaka-9", "Ulan",
  "Vesque", "Whitlock", "Xiang", "Yeboah", "Zhukov", "Abara", "Bellweather",
  "Castel", "Draven", "Ephrath", "Foss", "Garrow", "Hollis", "Ishida",
  "Jareth", "Kade", "Lockridge", "Marchetti", "Nassar", "Orsolya",
  "Pryce", "Quillan", "Renner", "Sagara", "Tovar", "Ulvang", "Vireo",
  "Warrick", "Xerxes", "Yarrow", "Zale", "Abernathy-Vox", "Blackwell",
  "Corrin", "Dahl", "Estrada", "Farro", "Grier", "Hux", "Ionescu",
  "Jax-11", "Kovac", "Lorne", "Mireille", "Nyström", "Orion", "Petrakis",
];
const SCIFI_POST_TEMPLATES = [
  "the recycler on deck 4 jammed again, third time this cycle #stationlife",
  "watched the ring nebula from the observation deck tonight, still not over it",
  "finally got my exosuit resealed after the hull breach scare",
  "the mess hall printer only makes protein paste taste like protein paste, help",
  "docked at the outer relay station, gravity's off and my stomach knows it",
  "{mention} owes me a favor after covering my shift during the comm blackout",
  "spent six hours recalibrating the nav array, worth it for a clean jump",
  "the colony's hydroponics bay finally yielded a real tomato, tiny victory",
  "picked up a strange signal near the asteroid field, probably nothing #probably",
  "my neural implant's been glitching since the last firmware push, anyone else",
  "{mention} nearly got us stuck in a decompression cycle, never doing that again",
  "the market district on the lower ring has the best synth-noodles in the sector",
  "traded my old thruster module for a proper upgrade, ship feels alive again",
  "three light-years from anywhere and someone still found a way to be annoying",
  "the AI core keeps humming a tune nobody programmed it to know, unsettling",
  "watched the terraforming crews light up the horizon from orbit, incredible",
  "{mention} beat my simulator record by half a second, rematch tomorrow",
  "finally fixed the leak in dome three, plants are safe for another cycle",
  "the megacorp raised docking fees again, whole station's furious",
  "spent shore leave at the station's zero-g lounge, worth every credit",
  "picked up an old-world record at the salvage market, still can't play it here",
  "the shuttle run got delayed by a debris field, stuck in orbit another day",
  "{mention} swears the vending bot on deck 2 is sentient, I believe it now",
  "logged my hundredth jump today, still get nervous every time",
  "the comms array's finally back online after the solar flare knocked it out",
  "found a stray cat living in the cargo bay, station's unofficial mascot now",
  "reprogrammed my drone to stop narrating everything I do, mostly successful",
  "the night shift crew left snacks in the airlock again, mystery solved eventually",
  "watched two moons rise at once from the colony ridge, never gets old",
  "finally saved enough credits for a real cabin upgrade, no more bunk pods",
];
const SCIFI_COMMENT_TEMPLATES = [
  "logging this for the record", "certified station legend",
  "{mention} we need to talk about this on the next shift",
  "this is why I keep my comm channel open", "the AI would approve of this",
  "sending this to the whole crew", "flagged for maximum relatability",
  "{mention} you're never living this down on this station",
  "this checks out, confirmed", "solid data, 10/10",
  "the whole deck is talking about this now", "logged and archived, iconic",
  "this belongs in the ship's log", "well that explains the alert earlier",
  "{mention} same energy as last cycle",
];
const HISTORICAL_FIRST_NAMES = [
  "Eleanor", "Frederick", "Cornelia", "Reginald", "Josephine", "Edmund",
  "Beatrice", "Augustus", "Charlotte", "Percival", "Henrietta", "Bartholomew",
  "Amelia", "Cornelius", "Winifred", "Theodore", "Clementine", "Ambrose",
  "Florence", "Nathaniel", "Adelaide", "Cyrus", "Genevieve", "Horace",
  "Isadora", "Leopold", "Marguerite", "Oswald", "Prudence", "Rupert",
  "Seraphina", "Thaddeus", "Vivienne", "Wilhelmina", "Alistair", "Beulah",
  "Casper", "Dorothea", "Ezekiel", "Fenella", "Gerald", "Hortense",
  "Ignatius", "Jemima", "Kingsley", "Lavinia", "Mortimer", "Ottoline",
  "Phineas", "Rosalind", "Silas", "Temperance", "Ulysses", "Verity",
  "Wendell", "Agatha", "Bertram", "Constance", "Delphine", "Ernestine",
  "Fitzgerald", "Griselda", "Humphrey", "Imogen", "Jasper", "Katharina",
  "Lucian", "Millicent", "Norbert", "Octavia", "Pemberton", "Rosamund",
  "Stanhope", "Theodosia", "Vernon", "Wilhelm", "Araminta", "Bertha",
  "Clarence", "Drusilla", "Ellsworth",
];
const HISTORICAL_LAST_NAMES = [
  "Ashworth", "Blackwood", "Cavendish", "Dashwood", "Ellsworth", "Fairfax",
  "Grantham", "Hawthorne", "Ingram", "Kingsley", "Langley", "Marchmont",
  "Norwood", "Osgood", "Pembroke", "Quincey", "Rutledge", "Sinclair",
  "Thackeray", "Underhill", "Vane", "Wickham", "Ashbourne", "Bellamy",
  "Chesterfield", "Drummond", "Everleigh", "Farthing", "Greavesend",
  "Hollingsworth", "Ivory", "Jarndyce", "Kensington", "Lockhart",
  "Mowbray", "Nettleford", "Overton", "Pettigrew", "Radcliffe", "Stanhope",
  "Trelawney", "Umbers", "Villiers", "Wetherby", "Ainsworth", "Beaumont",
  "Carrow", "Devereux", "Elphinstone", "Fenwick", "Gainsborough",
  "Harrowgate", "Iverson", "Jessop", "Knollys", "Lansbury", "Merriweather",
  "Northcote", "Ormsby", "Prescott", "Quarrington", "Rushworth", "Selwyn",
  "Thorncastle", "Uttley", "Vaughan", "Whitmore", "Ashfield", "Barrington",
  "Caversham", "Dunmore", "Effingham", "Featherstone", "Gresham",
  "Hollyhurst", "Ivyleaf", "Jennings", "Kirkland", "Latimer", "Marlowe",
];
const HISTORICAL_POST_TEMPLATES = [
  "the assembly rooms were unbearably crowded last evening, though the orchestra was fine",
  "received a most curious letter this morning, shall say no more until I've replied",
  "the new milliner on the high street has quite outdone herself this season",
  "spent the afternoon calling on {mention}, the tea was excellent, the gossip better",
  "father insists the carriage wants mending before we travel again, tiresome business",
  "the garden is finally coming along after all this spring's rain",
  "attended the assembly last night and danced rather more than was proper",
  "{mention} has promised to accompany us to the theatre on Thursday next",
  "the harvest this year promises to be a fine one, the tenants seem pleased",
  "quite scandalized by the news from town, shall write more once I know the whole of it",
  "spent the morning at my correspondence, my hand is quite cramped from it",
  "the new curate gave rather a long sermon this Sunday, I confess I dozed",
  "{mention} and I quarrelled again over the matter of the piano, all forgiven now",
  "the roads were so poor on our journey that we very nearly lost a wheel",
  "mother has decided the drawing room wants redecorating, again",
  "took a turn about the grounds this morning, the frost was quite lovely",
  "the ball at the manor was the talk of the county for a full week after",
  "{mention} sends word that the regiment is to be stationed nearby this winter",
  "spent the evening reading by the fire, a far better use of my time than cards",
  "the seamstress has finally finished my new gown, just in time for the assembly",
  "received callers all afternoon, scarcely had a moment to myself",
  "{mention} insists the new neighbours are perfectly respectable, I remain unconvinced",
  "the harvest fair in the village was a merry affair despite the mud",
  "wrote to my cousin at length about the events of the fortnight, she shall be scandalized",
  "the weather has finally turned, and not a moment too soon for the roads",
];
const HISTORICAL_COMMENT_TEMPLATES = [
  "well I never", "how perfectly scandalous", "you must tell me more at once",
  "{mention} we simply must discuss this over tea", "quite right, as ever",
  "I confess I laughed aloud reading this", "how very like you",
  "this shall be the talk of the parish by Sunday", "well said indeed",
  "{mention} you will never hear the end of this from me",
  "I am quite in agreement", "how delightfully improper",
  "this has quite made my morning", "{mention} do tell them what happened next",
  "a most excellent account",
];
const THEME_KEYWORDS = {
  fantasy: [
    "kingdom", "castle", "sword", "magic", "wizard", "sorcer", "dragon",
    "elf", "elves", "elven", "dwarf", "dwarves", "orc", "knight", "realm",
    "throne", "enchant", "spell", "mage", "potion", "tavern", "quest",
    "prophecy", "goblin", "fae ", "fairy", "witch", "druid", "paladin",
    "sorcery", "swordsman", "royal court", "adventurer", "dungeon",
    "sorceress", "enchanted forest", "mythical", "spellcaster", "rogue",
    "bard", "ranger", "barbarian", "cleric", "necromancer", "familiar",
    "medieval fantasy", "high fantasy", "village elder", "blacksmith",
  ],
  scifi: [
    "spaceship", "starship", "galaxy", "space station", "cyborg",
    "android", "robot", "hyperdrive", "laser", "blaster", "colony ship",
    "interstellar", "futuristic", "cybernetic", "neural implant", "mecha",
    "starfleet", "warp drive", "hologram", "cyberpunk", "spacecraft",
    "asteroid", "megacorp", "corporation", "neon-lit", "artificial intelligence",
    "space colony", "alien species", "extraterrestrial", "dystopian future",
    "orbital station", "terraform", "nanotech", "exosuit", "starport",
    "space marine", "android", "sentient ai", "planetside", "zero-g",
    "light-year", "wormhole", "quantum", "android crew", "escape pod",
  ],
  historical: [
    "victorian", "regency", "19th century", "18th century", "world war",
    "renaissance", "napoleonic", "industrial revolution", "corset",
    "carriage", "duke", "duchess", "earl", "countess", "ballroom", "manor",
    "estate", "governess", "butler", "wild west", "frontier", "saloon",
    "sheriff", "outlaw", "colonial", "gaslight", "steamship", "telegram",
    "period drama", "aristocra", "lordship", "ladyship", "drawing room",
    "chaperone", "footman", "lady's maid", "county assembly", "gentry",
    "parlor", "calling card", "season in town", "matrimony", "dowry",
  ],
};
// Maps each theme key to its full set of pools. "contemporary" reuses
// the module-level RANDOM_* pools defined above (the original,
// present-day set) rather than duplicating them here.
const THEME_PRESETS = {
  contemporary: {
    firstNames: RANDOM_FIRST_NAMES,
    lastNames: RANDOM_LAST_NAMES,
    postTemplates: RANDOM_POST_TEMPLATES,
    commentTemplates: RANDOM_COMMENT_TEMPLATES,
    bios: RANDOM_BIOS,
  },
  fantasy: {
    firstNames: FANTASY_FIRST_NAMES,
    lastNames: FANTASY_LAST_NAMES,
    postTemplates: FANTASY_POST_TEMPLATES,
    commentTemplates: FANTASY_COMMENT_TEMPLATES,
    bios: [
      "sellsword, mostly retired", "keeper of too many strays",
      "brews potions, results vary", "third son, first to leave the keep",
      "apprentice to the village healer", "collects tavern songs, sings none of them well",
      "wandering scholar, perpetually lost", "blacksmith's daughter, better with a hammer than most",
      "sworn to no lord, loyal to few", "hedge witch, harmless probably",
      "former squire, still owns the armor", "keeps bees, keeps secrets better",
      "minstrel between courts", "trades in rumors and rare herbs",
      "guard captain's second, does most of the work",
    ],
  },
  scifi: {
    firstNames: SCIFI_FIRST_NAMES,
    lastNames: SCIFI_LAST_NAMES,
    postTemplates: SCIFI_POST_TEMPLATES,
    commentTemplates: SCIFI_COMMENT_TEMPLATES,
    bios: [
      "deck engineer, third shift", "pilot, mediocre landings only",
      "runs the hydroponics bay", "salvage trader, ask about the discounts",
      "ex-military, doesn't talk about it", "station medic, allergic to irony",
      "AI systems tech, trusts the AI more than most crew",
      "cartographer of places that don't exist yet", "smuggler, allegedly retired",
      "colony liaison, professionally exhausted", "navigator, terrible at small talk",
      "xenobotanist, mostly excited about mold", "comms officer, hears everything",
      "freelance mechanic, station's unofficial hero",
      "cadet, still learning where everything is",
    ],
  },
  historical: {
    firstNames: HISTORICAL_FIRST_NAMES,
    lastNames: HISTORICAL_LAST_NAMES,
    postTemplates: HISTORICAL_POST_TEMPLATES,
    commentTemplates: HISTORICAL_COMMENT_TEMPLATES,
    bios: [
      "eldest daughter, reluctant heiress", "second son, purchased a commission",
      "governess to a most trying family", "keeper of the parish records",
      "seamstress to half the county", "recently returned from the continent",
      "devoted to correspondence and little else", "master of the hunt, mistress of gossip",
      "steward of the estate, keeper of its secrets", "a most persistent bachelor",
      "companion to an elderly aunt", "curate, new to the parish",
      "widow of independent means", "apprenticed to the family solicitor",
      "lately of London, not entirely by choice",
    ],
  },
};

// Short scene-setting hint fed into the LLM prompt when generating an
// actual ambient comment (see generateAmbientCommentText below), so a
// background extra's live reaction reads like it belongs to this
// theme's world instead of defaulting to modern-day internet voice.
const THEME_VOICE_HINTS = {
  contemporary: "a modern-day social media app - casual, present-day voice and slang",
  fantasy: "a medieval fantasy world (kingdoms, taverns, magic) - write in an in-world voice, no modern slang or technology",
  scifi: "a science-fiction space setting (starships, colonies, AI) - write in an in-world voice, no modern-day references",
  historical: "a Regency/Victorian-era setting - write in period-appropriate, slightly formal language, no modern slang",
};


// Best-effort guess at what kind of story this chat is set in, using
// the same plain-keyword-heuristic approach as FAME_KEYWORDS above -
// no network calls, no LLM round trip, just enough signal to steer
// the background cast's names and post flavor toward the right genre.
// Looks at the active character card first (description/personality/
// scenario/tags carry the strongest signal), then falls back to
// sampling actual chat narration, since a thin or generic card often
// won't mention the setting at all while the opening scene does.
function textSourcesForThemeDetection() {
  const sources = [];
  try {
    const list = context?.characters;
    const idx = context?.characterId;
    const card = Array.isArray(list) && idx != null ? list[idx] : null;
    if (card) {
      sources.push(
        card.description,
        card.personality,
        card.scenario,
        card.creatorcomment,
        Array.isArray(card.tags) ? card.tags.join(" ") : "",
        card.first_mes
      );
    }
  } catch (e) {
    /* no card available, fall through to chat narration below */
  }
  try {
    if (context?.chatMetadata?.scenario) sources.push(context.chatMetadata.scenario);
  } catch (e) {
    /* ignore */
  }
  try {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    // The opening messages usually establish the setting even when
    // the card itself is thin; the most recent ones catch a chat
    // that's drifted somewhere new since it started.
    chat.slice(0, 6).forEach((m) => sources.push(m?.mes));
    chat.slice(-6).forEach((m) => sources.push(m?.mes));
  } catch (e) {
    /* ignore */
  }
  return sources.filter(Boolean).join(" \n ").toLowerCase();
}

function detectChatTheme() {
  const text = textSourcesForThemeDetection();
  if (!text) return "contemporary";
  let best = "contemporary";
  let bestScore = 0;
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    const score = keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  // Require a couple of real hits before committing a themed cast -
  // one stray word shouldn't flip 3,000 background names away from
  // the safe contemporary default.
  return bestScore >= 2 ? best : "contemporary";
}

// The theme is locked in once a chat's random cast starts getting
// generated (see ensureRandomCast) and stored on s.randomCastTheme,
// so switching characters mid-conversation - or ST re-guessing
// differently on a later call - can't suddenly flip an already-seeded
// cast's names/flavor out from under an ongoing story. A manual
// override in settings (randomCastThemeOverride) always wins over
// auto-detection, for chats where the heuristic guesses wrong.
function resolveCastTheme(s) {
  if (s.randomCastTheme && THEME_PRESETS[s.randomCastTheme]) return s.randomCastTheme;
  const override = s.randomCastThemeOverride;
  const theme = override && override !== "auto" && THEME_PRESETS[override] ? override : detectChatTheme();
  s.randomCastTheme = theme;
  return theme;
}

function currentCastPreset(s) {
  return THEME_PRESETS[resolveCastTheme(s)] || THEME_PRESETS.contemporary;
}

const RANDOM_ACTIVITY_TICK_MS = 45 * 1000;
// Same shape/spirit as AUTO_POST_FREQUENCIES above: the chance, each
// tick, that a background profile does *something* (post, like,
// comment, or follow) - most ticks still do nothing.
const RANDOM_ACTIVITY_FREQUENCIES = {
  rare: 0.08,
  normal: 0.2,
  often: 0.4,
};

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generates a name that isn't already in use by any existing contact
// (real or ambient) - collisions would otherwise merge a background
// extra into whatever character happens to share their name. `preset`
// is one of the THEME_PRESETS entries, so the name matches whatever
// setting the current chat is in.
function generateRandomName(existingNames, preset) {
  const firstNames = preset.firstNames;
  const lastNames = preset.lastNames;
  for (let attempt = 0; attempt < 30; attempt++) {
    const name = `${randomChoice(firstNames)} ${randomChoice(lastNames)}`;
    if (!existingNames.has(name)) return name;
  }
  // Pool's exhausted (extremely unlikely at RANDOM_CAST_SIZE) - fall
  // back to a numbered variant rather than looping forever.
  return `${randomChoice(firstNames)} ${randomChoice(lastNames)} ${Math.floor(Math.random() * 1000)}`;
}

// Swaps a "{mention}" token (if the chosen template has one) for
// "@" + someone's name - almost always another cast member, sometimes
// the user themselves - shared by post captions and comments so both
// read the same way.
function fillMentionToken(template, castNames, authorName) {
  if (!template.includes("{mention}")) return template;
  const persona = currentPersonaName();
  const others = castNames.filter((n) => n !== authorName);
  const target = others.length && Math.random() < 0.8 ? randomChoice(others) : persona;
  return template.replace("{mention}", `@${target}`);
}

function generateRandomCaption(castNames, authorName, preset) {
  return fillMentionToken(randomChoice(preset.postTemplates), castNames, authorName);
}

function generateRandomCommentText(castNames, authorName, preset) {
  return fillMentionToken(randomChoice(preset.commentTemplates), castNames, authorName);
}

// Creates (once) a recurring cast of background profiles used to seed
// and animate the feed, so the same handful of "extras" show up again
// and again instead of an endless parade of one-off strangers - same
// idea as a real app's seeded demo data. Cheap to call repeatedly;
// it's a no-op once the cast is already full size. The cast's theme
// (names/bios/post flavor) is picked once per chat - see
// resolveCastTheme() - so it stays consistent for the life of the
// story instead of drifting every time this runs.
function ensureRandomCast() {
  const s = getSettings();
  if (!Array.isArray(s.randomCast)) s.randomCast = [];
  const preset = currentCastPreset(s);
  if (s.randomCast.length >= RANDOM_CAST_SIZE) return s.randomCast;
  const existing = new Set(Object.keys(s.contacts));
  while (s.randomCast.length < RANDOM_CAST_SIZE) {
    const name = generateRandomName(existing, preset);
    existing.add(name);
    const contact = ensureContact(name);
    contact.ambient = true; // flags this contact as feed flavor - see visibleContactNames()
    contact.bio = randomChoice(preset.bios);
    s.randomCast.push(name);
  }
  saveSettings();
  return s.randomCast;
}

// Wipes this chat's entire background cast - their contacts, any
// feed posts they authored, and any likes/comments/follows they left
// on other posts/the user (posts by real people are kept, just
// stripped of the departing cast members' likes/comments on them) -
// then rebuilds a fresh cast from scratch under whatever theme is
// currently in effect. Used by the "Regenerate this chat's background
// cast" settings button, typically after changing the theme override
// or realizing auto-detect guessed wrong for this story.
function regenerateRandomCast() {
  const s = getSettings();
  const oldCast = new Set(s.randomCast || []);
  if (oldCast.size) {
    s.feed = (s.feed || [])
      .filter((p) => !oldCast.has(p.author))
      .map((p) => {
        const leavingLikes = (p.likedBy || []).filter((n) => oldCast.has(n)).length;
        return {
          ...p,
          likedBy: (p.likedBy || []).filter((n) => !oldCast.has(n)),
          likes: Math.max(0, (p.likes || 0) - leavingLikes),
          comments: (p.comments || []).filter((c) => !oldCast.has(c.author)),
        };
      });
    s.notifications = (s.notifications || []).filter((n) => !oldCast.has(n.actor));
    for (const name of oldCast) {
      delete s.contacts[name];
      delete s.threads[name];
    }
  }
  s.randomCast = [];
  s.randomFeedSeeded = false;
  s.randomCastTheme = null; // forces resolveCastTheme() to re-derive: respects the override, or re-auto-detects
  ensureRandomCast();
  seedRandomFeed(true);
  saveSettings();
}

// Backfills a fresh chat's feed with a batch of posts (with likes and
// occasional comments already on them) from the random cast, so the
// Feed tab never opens empty. Runs once per chat unless `force` is
// passed (used by the "Add more random posts" settings button).
// Deliberately skips the usual notify()/toastr/unread-badge machinery
// that live activity uses below - this is backfilled history, not
// something that just happened, so it shouldn't announce itself.
function seedRandomFeed(force) {
  const s = getSettings();
  if (!s.randomFeedEnabled) return;
  if (s.randomFeedSeeded && !force) return;
  const cast = ensureRandomCast();
  if (!cast.length) return;
  const preset = currentCastPreset(s);

  const postCount = 70 + Math.floor(Math.random() * 41); // 70-110
  const now = Date.now();
  const newPosts = [];
  for (let i = 0; i < postCount; i++) {
    const author = randomChoice(cast);
    const authorContact = ensureContact(author);
    const caption = generateRandomCaption(cast, author, preset);
    const { tags, mentions } = extractTagsAndMentions(caption);
    // Spread across the last ~9 days so a cast this size still reads
    // as an ongoing history rather than a burst of posts that all
    // happened at once.
    const ts = now - Math.floor(Math.random() * 9 * 24 * 60 * 60 * 1000) - i * 1000;
    const maxLikes = Math.max(5, Math.floor((authorContact.followerCount || 100) * 0.08));
    const post = {
      id: crypto.randomUUID(),
      author,
      caption,
      tags,
      mentions,
      likes: Math.floor(Math.random() * Math.min(400, maxLikes)) + 1,
      likedByUser: false,
      views: 0,
      likedBy: [],
      comments: [],
      ts,
    };
    const commentCount = Math.random() < 0.6 ? Math.floor(Math.random() * 3) : 0;
    for (let c = 0; c < commentCount; c++) {
      const others = cast.filter((n) => n !== author);
      if (!others.length) break;
      const commenter = randomChoice(others);
      post.comments.push({
        author: commenter,
        text: generateRandomCommentText(cast, commenter, preset),
        ts: ts + (c + 1) * 60_000,
      });
    }
    newPosts.push(post);
  }
  newPosts.sort((a, b) => b.ts - a.ts); // newest-first, matching s.feed's own convention
  s.feed = [...newPosts, ...s.feed];
  s.randomFeedSeeded = true;
  saveSettings();
}

// ---------------------------------------------------------------
// Discovery/recommendation + reciprocal engagement
//
// Two related systems live here:
//  1. scorePostForYou() ranks the feed for a "For You" view using
//     recency, existing engagement, and the user's own affinity
//     history (which authors/tags they've actually liked/commented
//     on) - a small, transparent content-discovery algorithm rather
//     than a raw chronological dump.
//  2. userEngagementLevel()/runEngagementFeedbackTick() make the
//     user's own posts accrue views/likes/comments over time, at a
//     rate that scales with how active the user has been (liking and
//     commenting begets more visibility, the way real feeds work),
//     plus post recency and simple reach.
// ---------------------------------------------------------------

// Call whenever the user likes or comments, so userEngagementLevel()
// has something to look at. Timestamp-based (not a counter that needs
// manual decay) - old entries just age out of the lookback window on
// their own.
function recordUserEngagementAction() {
  const s = getSettings();
  if (!Array.isArray(s.userActionLog)) s.userActionLog = [];
  s.userActionLog.push(Date.now());
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  s.userActionLog = s.userActionLog.filter((t) => t > cutoff).slice(-200);
}

// 0..1: how active the user has been in roughly the last 2 hours,
// saturating at 15 actions. Feeds runEngagementFeedbackTick()'s odds.
function userEngagementLevel() {
  const s = getSettings();
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const count = (s.userActionLog || []).filter((t) => t > cutoff).length;
  return Math.min(1, count / 15);
}

// Weight > 0 to strengthen affinity (liking/commenting), weight < 0
// to weaken it (unliking). Powers scorePostForYou() below.
function bumpAffinity(post, weight) {
  const s = getSettings();
  if (!s.userAffinity) s.userAffinity = { authors: {}, tags: {} };
  const a = s.userAffinity;
  a.authors[post.author] = (a.authors[post.author] || 0) + weight;
  for (const t of post.tags || []) {
    a.tags[t] = (a.tags[t] || 0) + weight;
  }
}

// Everyone eligible to act as a "person" for engagement purposes: the
// procedural background cast plus every real contact the phone knows
// about (excluding unresolved "unknown number" threads and blocked
// contacts) - so reciprocal likes/comments and NPC-on-NPC activity
// aren't limited to just the background extras.
function engagementCandidateActors(s) {
  const persona = currentPersonaName();
  const names = new Set(s.randomCast || []);
  for (const n of getRoleplayCastNames()) names.add(n);
  for (const n of Object.keys(s.contacts || {})) {
    if (!s.contacts[n]?.unknown) names.add(n);
  }
  names.delete(persona);
  return Array.from(names).filter((n) => !isBlocked(n));
}

// Ranks a post for the "For You" feed sort: recent + already-popular
// content scores higher, and content from authors/tags the user has
// personally engaged with before scores higher still. A small random
// term keeps it from ever being perfectly stale/predictable.
function scorePostForYou(post, s) {
  const ageHours = (Date.now() - post.ts) / 3_600_000;
  const recency = Math.exp(-ageHours / 48); // ~2-day half-life-ish falloff
  const engagement = Math.log(1 + (post.likes || 0) + (post.comments?.length || 0) * 2 + (post.views || 0) * 0.1);
  const a = s.userAffinity || { authors: {}, tags: {} };
  const authorAffinity = a.authors[post.author] || 0;
  const tagAffinity = (post.tags || []).reduce((sum, t) => sum + (a.tags[t] || 0), 0);
  const affinity = authorAffinity * 1.5 + tagAffinity;
  const noise = Math.random() * 0.5;
  return recency * 1.2 + engagement * 0.8 + affinity + noise;
}

// Makes the user's own recent posts accrue views/likes/comments over
// time instead of sitting frozen at whatever they had when posted.
// Odds scale with userEngagementLevel() (how active the user's
// recently been) and each post's recency; likes/comments are
// attributed to real candidate actors via the same pushRandomLikeOnPost/
// pushRandomCommentOnPost used for background-cast activity, so
// they show up as real named reactions, not an anonymous counter tick.
function runEngagementFeedbackTick() {
  const s = getSettings();
  if (!s.enabled || !s.randomActivityEnabled) return;
  const persona = currentPersonaName();
  const myPosts = s.feed.filter((p) => p.author === persona).slice(0, 15);
  if (!myPosts.length) return;
  const actors = engagementCandidateActors(s);
  if (!actors.length) return;
  const level = userEngagementLevel();

  for (const post of myPosts) {
    const ageHours = (Date.now() - post.ts) / 3_600_000;
    const recencyFactor = Math.max(0.05, 1 - ageHours / 72); // fades out over ~3 days

    if (Math.random() < 0.5 * recencyFactor) {
      post.views = (post.views || 0) + Math.floor(1 + Math.random() * 4 * (0.5 + level));
    }
    if (Math.random() < 0.06 * recencyFactor * (0.4 + level)) {
      pushRandomLikeOnPost(randomChoice(actors), post);
    }
    if (Math.random() < 0.025 * recencyFactor * (0.4 + level)) {
      const actor = randomChoice(actors);
      pushRandomCommentOnPost(actor, post)
        .then((posted) => {
          if (posted) maybeReplyToComment(post, post.comments[post.comments.length - 1]);
        })
        .catch((e) => console.warn("[PhoneUI] Reciprocal comment tick failed unexpectedly.", e));
    }
  }
  saveSettings();
  renderPanel();
  updateToggleBadge();
}

// After any comment lands - the user's own, or an NPC's - occasionally
// has another candidate actor (preferring the post's author, since
// replying to a comment on your own post is the most natural case)
// write a short in-character reply to that specific comment. Flat
// comment list, Instagram-style - a reply is just another comment with
// a replyTo marker, not a nested thread.
async function maybeReplyToComment(post, comment) {
  const s = getSettings();
  if (!s.enabled || !s.randomActivityEnabled) return;
  if (typeof context?.generateQuietPrompt !== "function") return;
  if (quietGenerationInFlight) return;
  if (Math.random() > 0.5) return; // not every comment gets a reply

  const persona = currentPersonaName();
  const actors = engagementCandidateActors(s);
  const candidates = new Set();
  if (post.author !== comment.author && post.author !== persona) candidates.add(post.author);
  for (const c of post.comments) {
    if (c.author !== comment.author && c.author !== persona) candidates.add(c.author);
  }
  if (!candidates.size && actors.length) candidates.add(randomChoice(actors));
  const responder = Array.from(candidates)[0];
  if (!responder || isBlocked(responder)) return;

  const themeKey = resolveCastTheme(s);
  const voice = THEME_VOICE_HINTS[themeKey] || THEME_VOICE_HINTS.contemporary;
  const captionSnippet = (post.caption || "").slice(0, 200);
  const commentSnippet = (comment.text || "").slice(0, 200);
  const prompt =
    `You're ${responder}, a character in a story set in ${voice}. ${post.author} posted: "${captionSnippet}". ` +
    `${comment.author} just commented on it: "${commentSnippet}". Write ONE short, natural reply directly ` +
    `engaging with what ${comment.author} said, fully in character - a sentence or two at most. No stage ` +
    `directions, no quotation marks. Reply with ONLY the reply text and nothing else.`;

  quietGenerationInFlight = true;
  let raw;
  try {
    raw = await context.generateQuietPrompt({ quietPrompt: prompt });
  } catch (e) {
    console.warn("[PhoneUI] Comment reply generation failed.", e);
    quietGenerationInFlight = false;
    return;
  }
  quietGenerationInFlight = false;
  const text = (typeof raw === "string" ? raw : raw?.text || raw?.message || "").trim();
  const clean = text.split("\n")[0].replace(/^["“]|["”]$/g, "").trim();
  if (!clean || clean.length > 300) return;

  ensureContact(responder);
  post.comments.push({ author: responder, text: clean, ts: Date.now(), replyTo: comment.author });
  if (post.author === persona || comment.author === persona) {
    pushNotification("comment", responder, { text: clean, postId: post.id });
  } else {
    getSettings().unread += 1;
    saveSettings();
    renderPanel();
    updateToggleBadge();
  }
}

// Random-cast equivalent of a [LIKE:]/[COMMENT:]/[FOLLOW:] tag, but
// aimed at any feed post (not just the user's latest) and triggered
// on a timer instead of parsed out of a reply. Reuses pushNotification
// itself when the target is the user's own post, so it shows up in
// Notifications and fires a real toastr exactly like a tag-driven one
// would.
function pushRandomLikeOnPost(actorName, targetPost) {
  if (!targetPost || isBlocked(actorName)) return false;
  if (!targetPost.likedBy) targetPost.likedBy = [];
  if (targetPost.likedBy.includes(actorName)) return false; // already liked it
  ensureContact(actorName);
  targetPost.likedBy.push(actorName);
  targetPost.likes += 1;
  const persona = currentPersonaName();
  if (targetPost.author === persona) {
    pushNotification("like", actorName, { postId: targetPost.id });
  } else {
    saveSettings();
    renderPanel();
  }
  return true;
}

// Actually generates an ambient comment via the LLM (context.generateQuietPrompt) instead
// of picking from the canned RANDOM_COMMENT_TEMPLATES/theme comment lists, so a background
// extra's reaction responds to what the post genuinely says rather than a generic line that
// happens to fit. Returns null (never throws) on any failure - callers fall back to a
// templated comment so a flaky/unsupported build still gets ambient activity, just less
// bespoke. Gated by quietGenerationInFlight (declared up near attemptAutoPost, shared by
// every generateQuietPrompt call site) so it never overlaps another in-flight quiet generation.
async function generateAmbientCommentText(actorName, targetPost, themeKey) {
  if (typeof context?.generateQuietPrompt !== "function") return null;
  if (quietGenerationInFlight) return null;
  const voice = THEME_VOICE_HINTS[themeKey] || THEME_VOICE_HINTS.contemporary;
  const captionSnippet = (targetPost.caption || "").slice(0, 220);
  const prompt =
    `You're ${actorName}, a minor background character in a story set in ${voice}. ` +
    `${targetPost.author} just posted this on social media: "${captionSnippet}". ` +
    `Write ONE short, natural comment reacting to it, fully in character and voice for this setting - ` +
    `a sentence or two at most. No hashtags, no stage directions, no quotation marks around it. ` +
    `Reply with ONLY the comment text and nothing else.`;
  quietGenerationInFlight = true;
  try {
    const raw = await context.generateQuietPrompt({ quietPrompt: prompt });
    const text = (typeof raw === "string" ? raw : raw?.text || raw?.message || "").trim();
    if (!text) return null;
    // Keep just the first line and strip any wrapping quotes - guards
    // against the model padding its reply with narration/quote marks
    // despite the instructions above.
    const clean = text.split("\n")[0].replace(/^["“]|["”]$/g, "").trim();
    if (!clean || clean.length > 300) return null;
    return clean;
  } catch (e) {
    console.warn("[PhoneUI] Ambient comment generation failed, falling back to a templated reaction.", e);
    return null;
  } finally {
    quietGenerationInFlight = false;
  }
}

// Ambient-cast equivalent of the ambient comment generator above:
// actually asks the LLM to write a fresh, in-character post for a
// background extra instead of picking one of the canned
// RANDOM_POST_TEMPLATES/theme lines. Same contract - returns null
// (never throws) on any failure so callers can fall back to a
// templated line.
async function generateAmbientPostText(actorName, themeKey) {
  if (typeof context?.generateQuietPrompt !== "function") return null;
  if (quietGenerationInFlight) return null; // share the same in-flight guard as comments - one quiet generation at a time
  const voice = THEME_VOICE_HINTS[themeKey] || THEME_VOICE_HINTS.contemporary;
  const bio = getSettings().contacts[actorName]?.bio || "";
  const prompt =
    `You're ${actorName}, a minor background character in a story set in ${voice}.` +
    (bio ? ` Brief bio: ${bio}.` : "") +
    ` Write ONE short, natural social-media post as yourself - something you'd share unprompted ` +
    `(a thought, a moment from your day, a feeling), fully in character and voice for this setting. ` +
    `No hashtags unless it feels natural, no stage directions, no quotation marks around it. ` +
    `Reply with ONLY the post text and nothing else.`;
  quietGenerationInFlight = true;
  try {
    const raw = await context.generateQuietPrompt({ quietPrompt: prompt });
    const text = (typeof raw === "string" ? raw : raw?.text || raw?.message || "").trim();
    if (!text) return null;
    const clean = text.split("\n")[0].replace(/^["“]|["”]$/g, "").trim();
    if (!clean || clean.length > 300) return null;
    return clean;
  } catch (e) {
    console.warn("[PhoneUI] Ambient post generation failed, falling back to a templated post.", e);
    return null;
  } finally {
    quietGenerationInFlight = false;
  }
}

// Wraps pushFeedPost with real generation the same way
// pushRandomCommentOnPost wraps a plain comment push - tries the LLM
// first, falls back to a templated caption only if that's unavailable
// or fails.
async function pushRandomGeneratedPost(actorName, cast, s) {
  const themeKey = resolveCastTheme(s);
  const preset = THEME_PRESETS[themeKey] || THEME_PRESETS.contemporary;
  const generated = await generateAmbientPostText(actorName, themeKey);
  const caption = generated || generateRandomCaption(cast, actorName, preset);
  return pushFeedPost(actorName, caption);
}

async function pushRandomCommentOnPost(actorName, targetPost) {
  if (!targetPost || isBlocked(actorName)) return false;
  const s = getSettings();
  ensureContact(actorName);
  const themeKey = resolveCastTheme(s);
  const preset = THEME_PRESETS[themeKey] || THEME_PRESETS.contemporary;
  const generated = await generateAmbientCommentText(actorName, targetPost, themeKey);
  const text = generated || generateRandomCommentText(s.randomCast || [], actorName, preset);
  targetPost.comments.push({ author: actorName, text, ts: Date.now() });
  const persona = currentPersonaName();
  if (targetPost.author === persona) {
    pushNotification("comment", actorName, { text, postId: targetPost.id });
  } else {
    s.unread += 1;
    saveSettings();
    renderPanel();
    updateToggleBadge();
  }
  return true;
}

function pushRandomFollow(actorName) {
  if (isBlocked(actorName)) return false;
  const contact = ensureContact(actorName);
  if (contact.followsUser) return false; // already following, nothing new to announce
  contact.followsUser = true;
  pushNotification("follow", actorName);
  return true;
}

// One tick of ambient background activity: a random cast member
// posts, likes, comments, or follows, entirely on its own. Mostly
// mirrors attemptAutoPost's spirit while staying synthetic/offline
// (posts/likes/follows use the theme's canned templates, no LLM
// round trip) - except comments, which actually ask the LLM to write
// a real reaction to the specific post (see pushRandomCommentOnPost/
// generateAmbientCommentText) rather than picking a canned line, with
// a templated fallback if that generation isn't available or fails.
function ambientActivityTick() {
  const s = getSettings();
  if (!s.enabled || !s.randomActivityEnabled) return;
  const cast = ensureRandomCast();
  // Actor pool is now the background extras AND every real character
  // in the roleplay/contacts list - so known characters like/comment/
  // post/follow on each other's stuff too, not just the procedural
  // extras interacting among themselves.
  const actorPool = engagementCandidateActors(s);
  if (!actorPool.length) return;
  const actor = randomChoice(actorPool);
  if (isBlocked(actor)) return;

  const roll = Math.random();
  if (roll < 0.3) {
    // Fire-and-forget, same reasoning as the comment branch below:
    // generateAmbientPostText already swallows its own errors, this
    // catch is just a last-resort net against an unexpected rejection.
    pushRandomGeneratedPost(actor, actorPool, s).catch((e) =>
      console.warn("[PhoneUI] Ambient post tick failed unexpectedly.", e)
    );
  } else if (roll < 0.55) {
    const candidates = s.feed.filter((p) => p.author !== actor);
    if (candidates.length) pushRandomLikeOnPost(actor, randomChoice(candidates));
  } else if (roll < 0.8) {
    const candidates = s.feed.filter((p) => p.author !== actor);
    if (candidates.length) {
      const target = randomChoice(candidates);
      // Fire-and-forget: this tick doesn't need to block on the LLM
      // round trip. generateAmbientCommentText already swallows its
      // own errors, but this catch is a last-resort safety net so an
      // unexpected rejection here can never surface as an unhandled
      // promise rejection.
      pushRandomCommentOnPost(actor, target)
        .then((posted) => {
          if (posted) maybeReplyToComment(target, target.comments[target.comments.length - 1]);
        })
        .catch((e) => console.warn("[PhoneUI] Ambient comment tick failed unexpectedly.", e));
    }
  } else {
    pushRandomFollow(actor);
  }
}

let randomActivityTimerId = null;

function startRandomActivityTimer() {
  if (randomActivityTimerId) return; // already running
  randomActivityTimerId = setInterval(() => {
    const s = getSettings();
    if (!s.enabled || !s.randomActivityEnabled) return;
    const chance = RANDOM_ACTIVITY_FREQUENCIES[s.randomActivityFrequency] ?? RANDOM_ACTIVITY_FREQUENCIES.normal;
    if (Math.random() < chance) ambientActivityTick();
    // Same cadence as the ambient cast's own activity - the user's
    // posts get a chance each tick to pick up views/likes/comments
    // from the rest of the cast, scaled by how active the user's been.
    runEngagementFeedbackTick();
  }, RANDOM_ACTIVITY_TICK_MS);
}


// Sending (user -> chat)
// ---------------------------------------------------------------

// Pushes text into ST's normal input box and fires the send button,
// so the LLM sees it as context and can reply in character. Note:
// this makes formattedText appear as a real, visible message in the
// chat log (it's exactly what the user "said") - use queueHiddenNote
// below instead for anything that shouldn't show up as a spoken chat
// bubble (e.g. posting to the feed).
function sendToChat(formattedText) {
  const textarea = document.querySelector("#send_textarea");
  const sendButton = document.querySelector("#send_but");
  if (!textarea || !sendButton) {
    console.error("[PhoneUI] Could not find chat input to send through.");
    return;
  }
  textarea.value = formattedText;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  sendButton.click();
}

// ---------------------------------------------------------------
// Silent (chat-invisible) context notes
//
// Feed posts/comments/reposts need the LLM to *know* they happened
// (so characters can react to them) without that action ever
// appearing as a normal spoken chat message. sendToChat() above
// can't do that - it always adds a real, visible line to the log.
//
// Instead this uses ST's setExtensionPrompt() API, the same
// mechanism Author's Notes use: it injects a note directly into the
// prompt sent to the model, at a given depth, without it ever being
// added to the visible chat array. Notes queue up and get flushed in
// as one prompt right before use, then cleared the moment the next
// AI reply actually lands (its context has already been "spent" by
// then, so there's no reason to keep including it in every prompt
// after that).
// ---------------------------------------------------------------

const HIDDEN_NOTE_KEY = "phoneUI_silentContext";
let pendingHiddenNotes = [];

function flushHiddenNotes() {
  if (!context || typeof context.setExtensionPrompt !== "function") return;
  const types = context.extension_prompt_types || {};
  const roles = context.extension_prompt_roles || {};
  // IN_CHAT (depth-based, inserted near the most recent messages)
  // reads far more naturally here than BEFORE_PROMPT/IN_PROMPT would
  // (both of which land way up at the top, disconnected from "right
  // now"). Numeric fallbacks match ST's own extension_prompt_types/
  // extension_prompt_roles values in case an older build doesn't
  // export the enum objects themselves.
  const position = types.IN_CHAT ?? 1;
  const role = roles.SYSTEM ?? 0;
  const value = pendingHiddenNotes.length
    ? `[Behind-the-scenes context, not spoken aloud: ${pendingHiddenNotes.join(" ")}]`
    : "";
  try {
    context.setExtensionPrompt(HIDDEN_NOTE_KEY, value, position, 0, false, role);
  } catch (e) {
    console.warn("[PhoneUI] setExtensionPrompt failed, hidden note was dropped.", e);
  }
}

function queueHiddenNote(text) {
  if (!text) return;
  if (!context || typeof context.setExtensionPrompt !== "function") {
    // Nothing we can silently inject with on this ST build - rather
    // than have the action vanish from the model's awareness
    // entirely, fall back to the old (visible) behavior so
    // characters can still react to it, same as before this fix.
    console.warn("[PhoneUI] setExtensionPrompt unavailable on this build; falling back to a visible chat message.");
    sendToChat(text);
    return;
  }
  pendingHiddenNotes.push(text);
  flushHiddenNotes();
}

// Called once the next real AI reply lands - by then whatever was
// queued has already been read by the model, so there's no reason to
// keep re-sending it with every future prompt.
function clearHiddenNotes() {
  if (!pendingHiddenNotes.length) return;
  pendingHiddenNotes = [];
  flushHiddenNotes();
}

// ---------------------------------------------------------------
// Persistent phone/social-media context
//
// The notes above (queueHiddenNote) are one-shot: "X just happened",
// cleared after the very next reply. That's right for announcing an
// action in the moment, but it means the model has no way to bring
// up a post or a text conversation later, unprompted - "how'd you
// know I posted that?" would have no good answer once that one reply
// had passed.
//
// This instead keeps a standing summary of recent feed posts and
// text threads injected into every prompt via a second, separate
// setExtensionPrompt key (so it doesn't fight with the one-shot
// notes) - refreshed any time phone data actually changes, via a
// hook in saveSettings() rather than being called from every single
// place that mutates the feed/threads individually, so this can't
// quietly go stale if a future change forgets to call it.
// ---------------------------------------------------------------

const PHONE_CONTEXT_KEY = "phoneUI_persistentContext";
const MAX_CONTEXT_POSTS = 8;
const MAX_CONTEXT_THREADS = 5;
const MAX_CONTEXT_MSGS_PER_THREAD = 3;

function summarizePost(p) {
  const caption = (p.caption || (p.gif ? "[shared a GIF/meme]" : "[shared a post]")).slice(0, 100);
  const repost = p.repostOf ? ` (reposting ${p.repostOf.author}: "${(p.repostOf.caption || "").slice(0, 60)}")` : "";
  const likeNote = p.likes ? `, ${p.likes} like${p.likes === 1 ? "" : "s"}` : "";
  const commentNote = p.comments?.length ? `, ${p.comments.length} comment${p.comments.length === 1 ? "" : "s"}` : "";
  return `${p.author} posted: "${caption}"${repost}${likeNote}${commentNote}`;
}

function buildPhoneContextSummary(s) {
  const parts = [];

  if (s.feed?.length) {
    // s.feed is newest-first already.
    const posts = s.feed.slice(0, MAX_CONTEXT_POSTS).map(summarizePost);
    parts.push(`Recent social media feed posts, most recent first:\n- ${posts.join("\n- ")}`);
  }

  const threadNames = Object.keys(s.threads || {}).filter((n) => s.threads[n]?.length);
  if (threadNames.length) {
    threadNames.sort((a, b) => {
      const la = s.threads[a][s.threads[a].length - 1]?.ts || 0;
      const lb = s.threads[b][s.threads[b].length - 1]?.ts || 0;
      return lb - la; // most recently active thread first
    });
    const threadLines = threadNames.slice(0, MAX_CONTEXT_THREADS).map((name) => {
      const msgs = s.threads[name].slice(-MAX_CONTEXT_MSGS_PER_THREAD);
      const lines = msgs.map((m) => {
        const who = m.who === "user" ? currentPersonaName() : name;
        const text = (m.text || (m.gif ? "[GIF]" : "")).slice(0, 80);
        return `${who}: "${text}"`;
      });
      return `Texts with ${name} - ${lines.join(" / ")}`;
    });
    parts.push(`Recent text conversations:\n- ${threadLines.join("\n- ")}`);
  }

  const followers = Object.keys(s.contacts || {}).filter((n) => s.contacts[n]?.followsUser);
  const following = Object.keys(s.contacts || {}).filter((n) => s.contacts[n]?.following);
  if (followers.length || following.length) {
    const bits = [];
    if (followers.length) bits.push(`Follows the user: ${followers.slice(0, 15).join(", ")}`);
    if (following.length) bits.push(`The user follows: ${following.slice(0, 15).join(", ")}`);
    parts.push(`Social media follow relationships:\n- ${bits.join("\n- ")}`);
  }

  if (!parts.length) return "";
  return (
    `[Background context from the phone app - a real record of the social media feed and text ` +
    `conversations so far. Draw on it naturally if it's relevant (e.g. you can bring up, react to, or ` +
    `be affected by a post or text below, or a character can reference one they'd plausibly have seen), ` +
    `but don't recite this list verbatim or narrate that you're "checking your phone" unless that fits ` +
    `the scene:\n\n${parts.join("\n\n")}]`
  );
}

function refreshPhoneContextPrompt() {
  if (!context || typeof context.setExtensionPrompt !== "function") return;
  const s = getSettings();
  const types = context.extension_prompt_types || {};
  const roles = context.extension_prompt_roles || {};
  const position = types.IN_CHAT ?? 1;
  const role = roles.SYSTEM ?? 0;
  // A disabled phone shouldn't leak its data into prompts either -
  // matches the "disabled truly does nothing" rule used elsewhere in
  // this file (see the MESSAGE_RECEIVED handler).
  const summary = s.enabled ? buildPhoneContextSummary(s) : "";
  try {
    // Depth 2, not 0 - the one-shot notes above use depth 0, and
    // giving this its own depth keeps the two from overwriting each
    // other (they're different keys, so they wouldn't clobber one
    // another either way, but this also keeps the big standing
    // summary from crowding out whatever's most immediate).
    context.setExtensionPrompt(PHONE_CONTEXT_KEY, summary, position, 2, false, role);
  } catch (e) {
    console.warn("[PhoneUI] Failed to refresh persistent phone context.", e);
  }
}

// ---------------------------------------------------------------
// Teaching the model the tag syntax automatically
//
// Previously this only worked if the user hand-pasted the tag list
// from the README into a character's Author's Note/system prompt.
// That's easy to forget and has to be redone per character. Instead,
// when enabled (default on), this injects a compact version of the
// same instructions into every prompt via setExtensionPrompt, same
// mechanism as the persistent phone-context summary above but as its
// own key so the two never clobber each other. It's intentionally
// short (a condensed subset of the full tag list in README.md,
// focused on the ones that matter for a character to actually text/
// call/hand out a number to the user) so it doesn't eat too much of
// the context budget on every single generation.
// ---------------------------------------------------------------

const TAG_INSTRUCTION_KEY = "phoneUI_tagInstructions";

const TAG_INSTRUCTIONS_TEXT =
  `[Phone/social-media system: You can act through {{user}}'s phone by starting a line with one of these ` +
  `tags. Use them only when it fits the scene naturally, not in every reply.\n` +
  `[TEXT:YourName] message - send {{user}} a text.\n` +
  `[NUMBER:YourName] (555) 019-2847 - hand over your phone number in-scene (must look like a real 10-digit ` +
  `number, "555" exchange is the fictional-safe range); this is what adds you to {{user}}'s contacts.\n` +
  `[POST:YourName] caption - post to the shared social feed; @mention and #hashtag naturally.\n` +
  `[FOLLOW:YourName] - follow {{user}} on social media.\n` +
  `[LIKE:YourName] / [COMMENT:YourName] comment text - react to {{user}}'s latest post.\n` +
  `Only use [NUMBER:] when your character would plausibly hand over a real number in that moment (e.g. ` +
  `"here, put my number in your phone"), and only ever a 555-exchange number, never a real-looking one.]`;

function refreshTagInstructionPrompt() {
  if (!context || typeof context.setExtensionPrompt !== "function") return;
  const s = getSettings();
  const types = context.extension_prompt_types || {};
  const roles = context.extension_prompt_roles || {};
  // BEFORE_PROMPT (near the top, alongside the main system prompt)
  // reads more like a standing instruction/capability than IN_CHAT
  // does, which is used for the more moment-to-moment context notes.
  const position = types.BEFORE_PROMPT ?? 0;
  const role = roles.SYSTEM ?? 0;
  const value = s.enabled && s.teachTagsEnabled ? TAG_INSTRUCTIONS_TEXT : "";
  try {
    context.setExtensionPrompt(TAG_INSTRUCTION_KEY, value, position, 1, false, role);
  } catch (e) {
    console.warn("[PhoneUI] Failed to refresh tag-instruction prompt.", e);
  }
}

// Fires a real SillyTavern system notification (the same toastr popups
// ST itself uses for things like "Settings saved") in addition to this
// extension's own in-phone banner above. Wrapped defensively since
// toastr is a global provided by the host page, not something this
// extension controls - if some future ST build doesn't expose it (or
// it's mid-teardown on a page unload), this should never be the thing
// that throws.
function notifyToastr(message, title, type = "info") {
  try {
    if (typeof toastr === "undefined" || !toastr) return;
    const fn = typeof toastr[type] === "function" ? toastr[type] : toastr.info;
    fn.call(toastr, message, title);
  } catch (e) {
    console.warn("[PhoneUI] SillyTavern toastr notification failed.", e);
  }
}

// ---------------------------------------------------------------
// Notifications center (followed you / liked your post / commented /
// mentioned you / reposted your post) - a running feed of things
// other people did that involve the user, separate from the
// Texts/Feed/Discord unread counts. Backed by s.notifications.
// ---------------------------------------------------------------

const NOTIF_ICON = {
  follow: "fa-solid fa-user-plus",
  like: "fa-solid fa-heart",
  comment: "fa-solid fa-comment",
  mention: "fa-solid fa-at",
  repost: "fa-solid fa-retweet",
};

const NOTIF_TOASTR_TYPE = {
  follow: "info",
  like: "success",
  comment: "info",
  mention: "warning",
  repost: "info",
};

function notifTextFor(type, actorLabel) {
  switch (type) {
    case "follow":
      return `${actorLabel} followed you`;
    case "like":
      return `${actorLabel} liked your post`;
    case "comment":
      return `${actorLabel} commented on your post`;
    case "mention":
      return `${actorLabel} mentioned you`;
    case "repost":
      return `${actorLabel} reposted your post`;
    default:
      return `${actorLabel} did something`;
  }
}

// Records a notification-center entry and surfaces it two ways at
// once: a real ST toastr popup (so it feels like a genuine system
// notification, not just something buried in the phone app) and this
// extension's own phone-lock-screen banner via notify() (consistent
// with how texts/posts/Discord messages already announce themselves).
function pushNotification(type, actor, { text, postId } = {}) {
  const s = getSettings();
  const entry = {
    id: crypto.randomUUID(),
    type,
    actor,
    text: text || "",
    postId: postId || null,
    ts: Date.now(),
    read: false,
  };
  s.notifications.unshift(entry);
  // Keep it from growing unbounded over a very long chat.
  if (s.notifications.length > 300) s.notifications.length = 300;
  saveSettings();

  const actorLabel = displayName(actor);
  const message = notifTextFor(type, actorLabel);
  notifyToastr(message, "Notification", NOTIF_TOASTR_TYPE[type] || "info");
  notify({
    icon: NOTIF_ICON[type] || "fa-solid fa-bell",
    title: message,
    body: entry.text || message,
    onOpen: () => {
      activeTab = "notifications";
    },
  });

  renderPanel();
  updateToggleBadge();
}

// Checks a just-created feed post for a) mentioning the user, and b)
// (for reposts) being a repost of the user's own post - firing the
// matching notification if so. Safe to call for a post authored by
// the user themselves; it just no-ops (you mentioning/reposting
// yourself isn't a notification).
function notifyIfMentionsUser(post) {
  if (!post) return;
  const persona = currentPersonaName();
  if (post.author === persona) return;

  const mentioned = (post.mentions || []).some(
    (m) => m.toLowerCase() === persona.toLowerCase() || m.toLowerCase() === "you"
  );
  if (mentioned) {
    pushNotification("mention", post.author, { text: post.caption, postId: post.id });
  }

  if (post.repostOf && post.repostOf.author === persona) {
    pushNotification("repost", post.author, { text: post.caption, postId: post.id });
  }
}

// User-initiated follow/unfollow of a contact. Mirrors the tone of
// toggleLike/toggleBlock elsewhere in this file: an instant local
// toggle, no round trip needed for the user's own action to register.
// Following someone has a chance of a (delayed, so it doesn't feel
// instantaneous/robotic) follow-back - much rarer for famous contacts,
// since a celebrity following back every fan isn't how that works.
function toggleFollow(name) {
  const s = getSettings();
  const c = s.contacts[name];
  if (!c) return;
  c.following = !c.following;
  saveSettings();
  renderPanel();

  const persona = currentPersonaName();
  queueHiddenNote(
    c.following ? `${persona} just followed ${name} on social media.` : `${persona} just unfollowed ${name} on social media.`
  );

  if (c.following && !c.followsUser) {
    const followBackChance = c.famous ? 0.05 : 0.55;
    if (Math.random() < followBackChance) {
      const delay = 4000 + Math.random() * 12000;
      setTimeout(() => {
        const st = getSettings();
        const contact = st.contacts[name];
        // Bail out if things changed in the meantime (unfollowed
        // again, or somehow already followed back).
        if (!contact || !contact.following || contact.followsUser) return;
        contact.followsUser = true;
        saveSettings();
        pushNotification("follow", name);
      }, delay);
    }
  }
}

// ---------------------------------------------------------------
// Notifications (banner popups, like a phone lock screen)
// ---------------------------------------------------------------

function isPanelOpen() {
  const panel = document.querySelector("#phoneui-panel");
  return panel && !panel.classList.contains("phoneui-hidden");
}

function notify({ icon, title, body, onOpen }) {
  // Don't spam banners while the person is already looking at the phone.
  if (isPanelOpen()) return;

  const container = document.querySelector("#phoneui-notifications");
  if (!container) return;

  const banner = document.createElement("div");
  banner.className = "phoneui-toast";
  banner.innerHTML = `
    <i class="${icon} phoneui-toast-icon"></i>
    <div class="phoneui-toast-text">
      <div class="phoneui-toast-title">${escapeHtml(title)}</div>
      <div class="phoneui-toast-body">${escapeHtml(body.slice(0, 80))}</div>
    </div>
    <i class="fa-solid fa-xmark phoneui-toast-close"></i>`;

  banner.addEventListener("click", (e) => {
    if (e.target.classList.contains("phoneui-toast-close")) {
      banner.remove();
      return;
    }
    if (typeof onOpen === "function") onOpen();
    togglePanel();
    banner.remove();
  });

  container.prepend(banner);
  setTimeout(() => banner.remove(), 7000);

  // Keep the stack from growing unbounded if a lot lands at once.
  const all = container.querySelectorAll(".phoneui-toast");
  if (all.length > 4) all[all.length - 1].remove();
}

// ---------------------------------------------------------------
// GIFs / memes (Klipy-backed picker for reacting in chat)
// ---------------------------------------------------------------

// Unlike Giphy, Klipy doesn't publish one shared public demo key -
// every developer gets their own free test key (up to 100 req/hour)
// from the Klipy Partner Panel at klipy.com. So there's no working
// fallback key to ship here; leaving this blank makes getKlipyKey()
// fall through to whatever the user pastes into the settings drawer.
// A missing key (or no internet) is no longer a hard failure though -
// see LOCAL_GIF_LIBRARY below, which is what search/trending fall
// back to whenever Klipy itself isn't reachable.
const KLIPY_FALLBACK_KEY = "";

// Klipy's API wants a customer_id on every request (it's used for its
// per-user Recent-items/analytics features, which this extension
// doesn't use). A random value that stays stable for the lifetime of
// the tab is good enough here.
const KLIPY_CUSTOMER_ID = "phoneui-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

// fetch() with a timeout, so a flaky/half-up connection fails fast
// and falls through to the offline library instead of leaving the
// picker (or an NPC's GIF tag) hanging for a long time.
async function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// Offline reaction library - no network, no API key, works entirely
// client-side. Each entry is a tiny looping SVG (built at runtime as
// a data: URI, nothing fetched or bundled as a binary) standing in
// for a "gif" - a big emoji on a soft colour card with a gentle
// bounce animation. This is what search/trending fall back to
// whenever Klipy is unreachable (no key set, offline, request
// failed, or timed out), so GIF/meme reactions always work even with
// zero internet access; a real Klipy key just adds actual gifs into
// the mix on top of this when there's a connection.
function makeLocalGifDataUri(emoji, hue) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<rect width="200" height="200" rx="28" fill="hsl(${hue},70%,88%)"/>` +
    `<text x="100" y="132" font-size="112" text-anchor="middle">` +
    `<animate attributeName="y" values="132;120;132" dur="0.9s" repeatCount="indefinite"/>` +
    `${emoji}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const LOCAL_GIF_LIBRARY = [
  { id: "laugh", title: "Laughing", emoji: "😂", hue: 45, tags: ["laughing", "laugh", "lol", "funny", "haha"] },
  { id: "cry", title: "Crying", emoji: "😭", hue: 205, tags: ["crying", "cry", "sad", "sob", "tears"] },
  { id: "love", title: "Heart eyes", emoji: "😍", hue: 340, tags: ["heart eyes", "love", "love it", "adore", "swoon"] },
  { id: "shock", title: "Shocked", emoji: "😱", hue: 15, tags: ["shocked", "shock", "surprised", "scream", "omg"] },
  { id: "angry", title: "Angry", emoji: "😡", hue: 5, tags: ["angry", "mad", "rage", "furious"] },
  { id: "eyeroll", title: "Eye roll", emoji: "🙄", hue: 260, tags: ["eye roll", "eyeroll", "whatever", "unimpressed"] },
  { id: "fire", title: "Fire", emoji: "🔥", hue: 25, tags: ["fire", "lit", "hot", "flames"] },
  { id: "dead", title: "Dead", emoji: "💀", hue: 0, tags: ["dead", "skull", "im dead", "deceased"] },
  { id: "sideeye", title: "Side eye", emoji: "👀", hue: 40, tags: ["side eye", "sideeye", "eyes", "suspicious", "watching"] },
  { id: "thumbsup", title: "Thumbs up", emoji: "👍", hue: 130, tags: ["thumbs up", "thumbsup", "yes", "agree", "ok"] },
  { id: "thumbsdown", title: "Thumbs down", emoji: "👎", hue: 0, tags: ["thumbs down", "thumbsdown", "no", "disagree", "nope"] },
  { id: "celebrate", title: "Celebration", emoji: "🎉", hue: 300, tags: ["celebration", "celebrate", "party", "yay", "woo"] },
  { id: "dealwithit", title: "Deal with it", emoji: "🤝", hue: 200, tags: ["deal with it", "deal", "handshake", "agreed"] },
  { id: "clap", title: "Applause", emoji: "👏", hue: 50, tags: ["clap", "applause", "clapping", "bravo", "nice"] },
  { id: "wink", title: "Wink", emoji: "😉", hue: 320, tags: ["wink", "winking", "flirty"] },
  { id: "sleepy", title: "Sleepy", emoji: "😴", hue: 220, tags: ["sleepy", "tired", "sleep", "yawn", "bored"] },
  { id: "thinking", title: "Thinking", emoji: "🤔", hue: 40, tags: ["thinking", "hmm", "confused", "unsure", "suspicious"] },
  { id: "wave", title: "Wave", emoji: "👋", hue: 55, tags: ["wave", "waving", "hi", "hello", "bye", "goodbye"] },
  { id: "dance", title: "Dance", emoji: "💃", hue: 330, tags: ["dance", "dancing", "party"] },
  { id: "mindblown", title: "Mind blown", emoji: "🤯", hue: 15, tags: ["mind blown", "mindblown", "whoa", "shocked", "wow"] },
  { id: "cool", title: "Cool", emoji: "😎", hue: 210, tags: ["cool", "sunglasses", "chill", "smooth"] },
  { id: "blush", title: "Blushing", emoji: "☺️", hue: 350, tags: ["blush", "blushing", "shy", "embarrassed"] },
  { id: "facepalm", title: "Facepalm", emoji: "🤦", hue: 25, tags: ["facepalm", "smh", "ugh", "cringe"] },
  { id: "nervous", title: "Nervous", emoji: "😬", hue: 60, tags: ["nervous", "awkward", "yikes", "grimace"] },
  { id: "hug", title: "Hug", emoji: "🤗", hue: 30, tags: ["hug", "hugging", "comfort", "there there"] },
  { id: "kiss", title: "Kiss", emoji: "😘", hue: 345, tags: ["kiss", "kissing", "love", "xoxo"] },
  { id: "heart", title: "Heart", emoji: "❤️", hue: 355, tags: ["heart", "love", "like"] },
  { id: "sob", title: "Loud sobbing", emoji: "😢", hue: 210, tags: ["sob", "crying", "sad", "tears", "upset"] },
  { id: "smirk", title: "Smirk", emoji: "😏", hue: 280, tags: ["smirk", "smug", "sly", "sarcastic"] },
  { id: "clown", title: "Clown", emoji: "🤡", hue: 0, tags: ["clown", "joke", "ridiculous"] },
];

function localGifResult(entry) {
  const uri = makeLocalGifDataUri(entry.emoji, entry.hue);
  return { id: "local-" + entry.id, url: uri, preview: uri, title: entry.title, source: "local" };
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function searchLocalGifs(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return shuffled(LOCAL_GIF_LIBRARY).map(localGifResult);
  const words = q.split(/\s+/).filter(Boolean);
  const scored = LOCAL_GIF_LIBRARY.map((entry) => {
    let score = 0;
    for (const w of words) {
      if (entry.tags.some((t) => t === w)) score += 3;
      else if (entry.tags.some((t) => t.includes(w) || w.includes(t))) score += 2;
      if (entry.title.toLowerCase().includes(w)) score += 1;
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).map((s) => s.entry);
  const pool = matched.length ? matched : shuffled(LOCAL_GIF_LIBRARY);
  return pool.map(localGifResult);
}

// Quick-tap shortcuts for common chat reactions, each mapped to a
// search term so picking a "reaction" is one tap instead of having
// to type a search query every time.
const GIF_QUICK_REACTIONS = [
  { emoji: "😂", label: "Laughing", query: "laughing" },
  { emoji: "😭", label: "Crying", query: "crying" },
  { emoji: "😍", label: "Love it", query: "heart eyes" },
  { emoji: "😱", label: "Shocked", query: "shocked" },
  { emoji: "😡", label: "Angry", query: "angry" },
  { emoji: "🙄", label: "Eye roll", query: "eye roll" },
  { emoji: "🔥", label: "Fire", query: "fire" },
  { emoji: "💀", label: "Dead", query: "dead" },
  { emoji: "👀", label: "Side eye", query: "side eye" },
  { emoji: "👍", label: "Thumbs up", query: "thumbs up" },
  { emoji: "🎉", label: "Celebrate", query: "celebration" },
  { emoji: "🤝", label: "Deal", query: "deal with it" },
];

function getKlipyKey() {
  const s = getSettings();
  return (s.gifApiKey || "").trim() || KLIPY_FALLBACK_KEY;
}

class KlipyKeyMissingError extends Error {}

// Klipy nests each size variant (e.g. "hd", "md", "sm", "xs") under
// `files`, and each variant can carry gif/mp4/webp sub-formats. Field
// names have shifted a bit across Klipy API versions, so this pulls
// the best available url/preview defensively instead of assuming one
// exact shape.
function pickKlipyFormat(files) {
  if (!files || typeof files !== "object") return null;
  const sizeOrder = ["hd", "md", "sm", "xs", "4xs", "original"];
  const typeOrder = ["gif", "webp", "mp4"];
  for (const size of sizeOrder) {
    const variant = files[size];
    if (!variant) continue;
    for (const type of typeOrder) {
      const f = variant[type];
      if (f && (f.url || f.src)) return f;
    }
    // Some responses put url/width/height directly on the size object.
    if (variant.url || variant.src) return variant;
  }
  return null;
}

function normalizeKlipyResult(g) {
  // Klipy's own docs call this field `files`, but real-world responses
  // have also been seen keyed as `file` (singular) - check both.
  const files = g.files || g.file || null;
  const full = pickKlipyFormat(files) || {};
  const previewSize = (files && (files.sm || files.xs || files["4xs"])) || null;
  const preview = pickKlipyFormat(previewSize ? { sm: previewSize } : null) || full;
  const url = full.url || full.src || g.url;
  return {
    id: g.id || g.slug,
    url,
    preview: preview.url || preview.src || url,
    title: g.title || g.slug || "gif",
  };
}

function klipyBaseUrl(kind) {
  const key = getKlipyKey();
  if (!key) throw new KlipyKeyMissingError("No Klipy API key configured.");
  return `https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/${kind}`;
}

// online-ness is checked defensively - navigator.onLine can be wrong
// (e.g. true on a captive portal with no real access), so it's only
// used to skip an attempt we already know will fail, never trusted as
// proof a request will succeed. The real safety net is the try/catch
// below falling through to the offline library on any failure.
function looksOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

async function klipySearch(query) {
  const key = getKlipyKey();
  if (key && looksOnline()) {
    try {
      const url = `${klipyBaseUrl("search")}?q=${encodeURIComponent(query)}&per_page=24&page=1&customer_id=${encodeURIComponent(KLIPY_CUSTOMER_ID)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`Klipy search failed (${res.status})`);
      const data = await res.json();
      const items = (data.data && data.data.data) || data.data || [];
      const mapped = items.map(normalizeKlipyResult);
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn("[PhoneUI] Klipy search unavailable, using the offline reaction library instead.", e);
    }
  }
  return searchLocalGifs(query);
}

async function klipyTrending() {
  const key = getKlipyKey();
  if (key && looksOnline()) {
    try {
      const url = `${klipyBaseUrl("trending")}?per_page=24&page=1&customer_id=${encodeURIComponent(KLIPY_CUSTOMER_ID)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`Klipy trending failed (${res.status})`);
      const data = await res.json();
      const items = (data.data && data.data.data) || data.data || [];
      const mapped = items.map(normalizeKlipyResult);
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn("[PhoneUI] Klipy trending unavailable, using the offline reaction library instead.", e);
    }
  }
  return searchLocalGifs("");
}

// Picks a GIF for an NPC-triggered tag ([GIF], [GROUPGIF], etc.) -
// same Klipy backend as the user-facing picker, just auto-picking the
// top result instead of showing a grid to tap. Returns null (instead
// of throwing) on any failure, so callers can fall back to a plain
// text bubble explaining what happened.
async function resolveGifForQuery(query) {
  const q = (query || "").trim();
  try {
    const results = q ? await klipySearch(q) : await klipyTrending();
    return results[0] || null;
  } catch (e) {
    console.error("[PhoneUI] NPC GIF fetch failed.", e);
    return null;
  }
}

// Keeps any one character from spamming GIFs - across texts, group
// chats, Discord, and posts alike, since they all funnel through the
// same per-name cooldown. Deliberately generous (a minute) since it's
// meant to stop reaction spam, not stop a character from ever sending
// a second GIF in a scene.
const GIF_COOLDOWN_MS = 60_000;

function canSendNpcGif(senderName) {
  const st = getSettings();
  const last = st.lastGifSentAt[senderName] || 0;
  return Date.now() - last >= GIF_COOLDOWN_MS;
}

// Marked synchronously, before the (async) GIF fetch even starts, so
// that if a model stuffs several GIF tags for the same character into
// one message, only the first is honored instead of all of them
// racing past the cooldown check together.
function markNpcGifSent(senderName) {
  const st = getSettings();
  st.lastGifSentAt[senderName] = Date.now();
}

// Picker state. onSelect(gifObj) is called (and the picker closed)
// when the user taps a result.
let gifPicker = {
  open: false,
  onSelect: null,
  query: "",
  loading: false,
  error: null,
  results: [],
  requestId: 0,
};

function openGifPicker(onSelect) {
  gifPicker = { open: true, onSelect, query: "", loading: true, error: null, results: [], requestId: gifPicker.requestId + 1 };
  renderPanel();
  runGifSearch("");
}

function closeGifPicker() {
  gifPicker.open = false;
  renderPanel();
}

async function runGifSearch(query) {
  const myRequest = ++gifPicker.requestId;
  gifPicker.loading = true;
  gifPicker.error = null;
  renderGifPickerOnly();
  try {
    // klipySearch/klipyTrending never throw - they fall back to the
    // offline reaction library on any failure - so this branch is
    // just a last-resort safety net.
    const results = query.trim() ? await klipySearch(query.trim()) : await klipyTrending();
    if (myRequest !== gifPicker.requestId) return; // a newer search superseded this one
    gifPicker.results = results;
    gifPicker.loading = false;
  } catch (e) {
    if (myRequest !== gifPicker.requestId) return;
    console.error("[PhoneUI] GIF search failed unexpectedly.", e);
    gifPicker.loading = false;
    gifPicker.error = "Couldn't load GIFs or reactions. Try again in a moment.";
  }
  renderGifPickerOnly();
}

let gifSearchDebounce = null;
function debouncedGifSearch(query) {
  gifPicker.query = query;
  clearTimeout(gifSearchDebounce);
  gifSearchDebounce = setTimeout(() => runGifSearch(query), 400);
}

// Re-renders just the picker overlay in place, without tearing down
// and rebuilding the whole tab body (which would lose input focus).
function renderGifPickerOnly() {
  const overlay = document.querySelector("#phoneui-gifpicker");
  if (!overlay) return;
  overlay.outerHTML = renderGifPicker();
  attachGifPickerListeners();
}

function renderGifPicker() {
  if (!gifPicker.open) return "";
  return `
    <div id="phoneui-gifpicker" class="phoneui-gifpicker">
      <div class="phoneui-gifpickerhead">
        <i class="fa-solid fa-chevron-left" id="phoneui-gifback"></i>
        <input type="text" id="phoneui-gifsearch" placeholder="Search GIFs..." value="${escapeHtml(gifPicker.query)}" />
      </div>
      <div class="phoneui-gifquick">
        ${GIF_QUICK_REACTIONS.map(
          (r) => `<div class="phoneui-gifquickchip" data-query="${escapeHtml(r.query)}" title="${escapeHtml(r.label)}">${r.emoji}</div>`
        ).join("")}
      </div>
      <div class="phoneui-gifgrid">
        ${
          gifPicker.loading
            ? `<div class="phoneui-empty">Loading GIFs...</div>`
            : gifPicker.error
            ? `<div class="phoneui-empty">${escapeHtml(gifPicker.error)}</div>`
            : gifPicker.results.length === 0
            ? `<div class="phoneui-empty">No GIFs found. Try a different search.</div>`
            : gifPicker.results
                .map(
                  (g) =>
                    `<img class="phoneui-gifoption" src="${escapeHtml(g.preview)}" data-gifid="${escapeHtml(g.id)}" alt="${escapeHtml(g.title)}" />`
                )
                .join("")
        }
      </div>
    </div>`;
}

function attachGifPickerListeners() {
  document.querySelector("#phoneui-gifback")?.addEventListener("click", closeGifPicker);
  const searchInput = document.querySelector("#phoneui-gifsearch");
  searchInput?.addEventListener("input", (e) => debouncedGifSearch(e.target.value));
  // Keep focus/cursor in the search box across re-renders while typing.
  if (searchInput && document.activeElement !== searchInput && gifPicker.query) {
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  document.querySelectorAll(".phoneui-gifquickchip").forEach((el) => {
    el.addEventListener("click", () => {
      const q = el.dataset.query;
      const input = document.querySelector("#phoneui-gifsearch");
      if (input) input.value = q;
      debouncedGifSearch(q);
    });
  });
  document.querySelectorAll(".phoneui-gifoption").forEach((el) => {
    el.addEventListener("click", () => {
      const gif = gifPicker.results.find((g) => String(g.id) === el.dataset.gifid);
      if (!gif) return;
      const cb = gifPicker.onSelect;
      closeGifPicker();
      if (typeof cb === "function") cb(gif);
    });
  });
}

function userSendText(contactName, text, gif, note) {
  const s = getSettings();
  if (!s.threads[contactName]) s.threads[contactName] = [];
  s.threads[contactName].push({ who: "user", text, gif: gif || null, ts: Date.now() });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  const contextNote = note ? `${note} ` : "";
  sendToChat(`[TEXT:${currentPersonaName()} to ${contactName}] ${contextNote}${gifNote}${text}`.trim());
}

function userSendGroupText(groupName, text, gif) {
  const s = getSettings();
  if (!s.groupThreads[groupName]) s.groupThreads[groupName] = [];
  s.groupThreads[groupName].push({ who: "user", sender: currentPersonaName(), text, gif: gif || null, ts: Date.now() });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  sendToChat(`[GROUPTEXT:${groupName}:${currentPersonaName()}] ${gifNote}${text}`.trim());
}

function userSendPost(caption, gif) {
  const s = getSettings();
  const { tags, mentions } = extractTagsAndMentions(caption);
  s.feed.unshift({
    id: crypto.randomUUID(),
    author: currentPersonaName(),
    caption,
    gif: gif || null,
    tags,
    mentions,
    likes: 0,
    likedByUser: false,
      views: 0,
    comments: [],
    ts: Date.now(),
  });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[posted a GIF/meme: "${gif.title}"] ` : "";
  // Bug fix: this used to call sendToChat(), which types the raw
  // "[POST:Name] caption" line into the actual chat input and clicks
  // Send - so every feed post also showed up as a normal spoken
  // message in the visible chat log (and got a full in-character
  // reply generated for it), which isn't what posting to a social
  // feed should look like. queueHiddenNote() tells the LLM the same
  // thing through a hidden context note instead, so characters can
  // still react to it, without it ever appearing as something the
  // user "said" out loud.
  queueHiddenNote(`${currentPersonaName()} just posted to social media: ${gifNote}${caption}`.trim());
}

function userComment(postId, text) {
  const s = getSettings();
  const post = s.feed.find((p) => p.id === postId);
  if (!post) return;
  const comment = { author: currentPersonaName(), text, ts: Date.now() };
  post.comments.push(comment);
  bumpAffinity(post, 2); // commenting is a stronger signal than liking
  recordUserEngagementAction();
  saveSettings();
  renderPanel();
  queueHiddenNote(
    `${currentPersonaName()} just commented on ${post.author}'s post ("${post.caption.slice(0, 40)}"): ${text}`
  );
  // Give someone in the thread (preferably the post's author) a
  // chance to actually reply to what the user just said, instead of
  // the comment just sitting there.
  maybeReplyToComment(post, comment).catch((e) =>
    console.warn("[PhoneUI] Reply to the user's comment failed unexpectedly.", e)
  );
}

function acceptInvite(inviteId) {
  const s = getSettings();
  const invite = s.discordInvites.find((i) => i.id === inviteId);
  if (!invite) return;
  ensureServer(invite.server);
  s.discordInvites = s.discordInvites.filter((i) => i.id !== inviteId);
  saveSettings();
  renderPanel();
  sendToChat(`[SYSTEM] ${currentPersonaName()} accepted the invite to join the "${invite.server}" Discord server.`);
}

function declineInvite(inviteId) {
  const s = getSettings();
  s.discordInvites = s.discordInvites.filter((i) => i.id !== inviteId);
  saveSettings();
  renderPanel();
}

function userSendDiscordMessage(serverName, channelName, text, gif) {
  const s = getSettings();
  const server = s.discordServers[serverName];
  if (!server) return;
  if (!server.channels[channelName]) server.channels[channelName] = [];
  server.channels[channelName].push({
    author: currentPersonaName(),
    text,
    gif: gif || null,
    isUser: true,
    ts: Date.now(),
  });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  sendToChat(`[DISCORD:${serverName}>${channelName} from ${currentPersonaName()}] ${gifNote}${text}`.trim());
}

function toggleLike(postId) {
  const s = getSettings();
  const post = s.feed.find((p) => p.id === postId);
  if (!post) return;
  post.likedByUser = !post.likedByUser;
  post.likes += post.likedByUser ? 1 : -1;
  bumpAffinity(post, post.likedByUser ? 1 : -1);
  if (post.likedByUser) recordUserEngagementAction();
  saveSettings();
  renderPanel();
}

// Reposts an existing feed post as the user, with an optional caption
// of their own - the user-facing equivalent of an NPC's [REPOST] tag.
function userRepost(postId) {
  const s = getSettings();
  const original = s.feed.find((p) => p.id === postId);
  if (!original) return;
  const captionInput = prompt("Add a caption to your repost (optional):", "");
  if (captionInput === null) return; // cancelled
  const cleanCaption = captionInput.trim();
  const { tags, mentions } = extractTagsAndMentions(cleanCaption);
  // Reposting a repost points back at the original, not the repost.
  const src = original.repostOf || original;
  s.feed.unshift({
    id: crypto.randomUUID(),
    author: currentPersonaName(),
    caption: cleanCaption,
    tags,
    mentions,
    likes: 0,
    likedByUser: false,
      views: 0,
    comments: [],
    ts: Date.now(),
    repostOf: { id: src.id, author: src.author, caption: src.caption, gif: src.gif || null },
  });
  saveSettings();
  renderPanel();
  const captionNote = cleanCaption ? ` with the caption: ${cleanCaption}` : "";
  queueHiddenNote(`${currentPersonaName()} just reposted ${src.author}'s post${captionNote}`.trim());
}

// ---------------------------------------------------------------
// Stories (derived from recent Feed posts - no separate data to
// maintain, one strip entry per author who's posted recently)
// ---------------------------------------------------------------

const STORY_WINDOW_MS = 24 * 60 * 60 * 1000; // posts from the last 24h show up as stories
const STORY_DURATION_MS = 5000; // how long each story auto-plays before advancing

// Groups the feed's recent posts by author, oldest-first per author
// (so a person's stories play back in the order they posted them).
// Returns a Map so insertion order (= first-seen order scanning the
// feed) is preserved for "which author comes next" navigation.
function getStoryGroups() {
  const s = getSettings();
  const cutoff = Date.now() - STORY_WINDOW_MS;
  const byAuthor = new Map();
  // s.feed is newest-first; walk it in reverse to build each author's
  // posts oldest-first.
  for (let i = s.feed.length - 1; i >= 0; i--) {
    const p = s.feed[i];
    if (p.ts < cutoff) continue;
    if (!byAuthor.has(p.author)) byAuthor.set(p.author, []);
    byAuthor.get(p.author).push(p);
  }
  return byAuthor;
}

let storyViewer = { open: false, author: null, index: 0, timerId: null };
// Draft text for the story-reply box, kept outside storyViewer so it
// survives the re-renders that don't touch it (typing indicators,
// etc.) without losing focus - same pattern as messageDrafts.
let storyReplyDraft = "";

function stopStoryTimer() {
  if (storyViewer.timerId) {
    clearTimeout(storyViewer.timerId);
    storyViewer.timerId = null;
  }
}

function closeStoryViewer() {
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  storyReplyDraft = "";
  renderPanel();
}

// Replying to a story becomes a normal DM to that character - closes
// the viewer and drops the user straight into the resulting thread,
// same as tapping "reply" on a real stories UI.
function replyToStory(text) {
  if (!storyViewer.open || !text.trim()) return;
  const author = storyViewer.author;
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  storyReplyDraft = "";
  userSendText(author, text.trim(), null, "(replying to their story)");
  activeTab = "texts";
  activeThread = author;
  activeGroup = null;
  renderPanel();
}

function markStoryViewed(author) {
  const s = getSettings();
  s.storiesViewed[author] = Date.now();
  saveSettings();
}

function openStoryViewer(author) {
  const groups = getStoryGroups();
  if (!groups.has(author)) return;
  stopStoryTimer();
  storyViewer = { open: true, author, index: 0, timerId: null };
  markStoryViewed(author);
  renderPanel();
}

// delta is +1 (next) or -1 (previous). Falls off the end of one
// author's stories into the next author's, like real stories UIs.
function advanceStory(delta) {
  const groups = getStoryGroups();
  const posts = groups.get(storyViewer.author) || [];
  const nextIndex = storyViewer.index + delta;

  if (nextIndex < 0) {
    storyViewer.index = 0; // already first story - just restart it
    renderPanel();
    return;
  }
  if (nextIndex >= posts.length) {
    const authors = [...groups.keys()];
    const nextAuthor = authors[authors.indexOf(storyViewer.author) + 1];
    if (nextAuthor) openStoryViewer(nextAuthor);
    else closeStoryViewer();
    return;
  }
  storyViewer.index = nextIndex;
  markStoryViewed(storyViewer.author);
  renderPanel();
}

// Called after every render; (re)starts the auto-advance timer only
// while the viewer is actually open, and never lets more than one
// timer run at once.
function scheduleStoryAdvance() {
  stopStoryTimer();
  if (!storyViewer.open) return;
  if (storyReplyDraft) return; // don't auto-advance out from under a reply in progress
  storyViewer.timerId = setTimeout(() => advanceStory(1), STORY_DURATION_MS);
}

function renderStoriesStrip() {
  const groups = getStoryGroups();
  if (groups.size === 0) return "";
  const s = getSettings();
  return `<div class="phoneui-stories">
    ${[...groups.entries()]
      .map(([author, posts]) => {
        const latest = posts[posts.length - 1];
        const seen = (s.storiesViewed[author] || 0) >= latest.ts;
        return `<div class="phoneui-story" data-storyauthor="${escapeHtml(author)}">
          <div class="phoneui-story-ring ${seen ? "phoneui-story-seen" : ""}">
            ${avatarHtml(initials(author), avatarPhotoFor(author))}
          </div>
          <span>${escapeHtml(author)}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderStoryViewer() {
  if (!storyViewer.open) return "";
  const groups = getStoryGroups();
  const posts = groups.get(storyViewer.author) || [];
  const post = posts[storyViewer.index];
  if (!post) return "";
  return `<div class="phoneui-storyviewer" id="phoneui-storyviewer">
    <div class="phoneui-storyprogress">
      ${posts
        .map(
          (_, i) =>
            `<div class="phoneui-storyprogressbar"><div class="phoneui-storyprogressfill ${
              i < storyViewer.index
                ? "phoneui-storyprogressdone"
                : i === storyViewer.index
                ? "phoneui-storyprogressactive"
                : ""
            }"></div></div>`
        )
        .join("")}
    </div>
    <div class="phoneui-storyheader">
      ${avatarHtml(initials(storyViewer.author), avatarPhotoFor(storyViewer.author), "phoneui-avatar-sm")}
      <span>${escapeHtml(storyViewer.author)}</span>
      <i class="fa-solid fa-xmark" id="phoneui-storyclose"></i>
    </div>
    <div class="phoneui-storybody">
      ${post.gif ? `<img src="${escapeHtml(post.gif.url)}" alt="${escapeHtml(post.gif.title)}" />` : ""}
      ${post.caption ? `<div class="phoneui-storycaption">${renderCaption(post.caption)}</div>` : ""}
      <div class="phoneui-storytap phoneui-storytap-left" id="phoneui-storyprev"></div>
      <div class="phoneui-storytap phoneui-storytap-right" id="phoneui-storynext"></div>
    </div>
    <div class="phoneui-inputrow phoneui-storyreply">
      <input type="text" id="phoneui-storyreplyinput" placeholder="Reply to ${escapeHtml(
        storyViewer.author
      )}" value="${escapeHtml(storyReplyDraft)}" />
      <i class="fa-solid fa-arrow-up" id="phoneui-storyreplysend"></i>
    </div>
  </div>`;
}

// ---------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------

let activeTab = "home";
let activeThread = null;
let activeGroup = null;
let activeServer = null;
let activeChannel = null;
// Which contact's profile page is currently open, if any. This is an
// overlay on top of whatever activeTab is (same idea as a 1:1 thread
// being "inside" the Texts tab) - renderPanel() checks this first and,
// if set, renders the profile view instead of the normal tab body.
// Cleared whenever the user switches tabs or taps the profile's own
// back button.
let activeProfile = null;
// In-progress reply text for the active thread/group - kept here so
// that renderPanel() calls triggered in the background (typing
// indicators starting/stopping, an incoming message arriving) don't
// wipe out a draft the user is still typing. Same pattern as
// groupCreate.name below.
let messageDrafts = { threads: {}, groups: {} };
// In-progress "start a new group" form (name + which contacts are picked).
let groupCreate = { open: false, name: "", selected: new Set() };

// Fake "typing..." delay state - transient/in-memory only (not saved
// to chat metadata, doesn't need to survive a reload). Tracks who
// currently *appears* to be typing so the UI can show animated dots
// before their [TEXT:]/[GROUPTEXT:] message actually lands in the
// thread. Cleared the moment each message is delivered.
let typingThreads = new Set(); // contact names typing in a 1:1 thread
let typingGroups = {}; // { groupName: Set(sender names typing in that group) }
// Pending setTimeout ids for in-flight typing deliveries, so they can
// be cancelled if the chat changes before they fire (otherwise a
// delayed message from the old chat would land in whichever chat is
// active when the timer finally goes off).
let pendingTypingTimers = new Set();

function clearTypingState() {
  for (const id of pendingTypingTimers) clearTimeout(id);
  pendingTypingTimers.clear();
  typingThreads.clear();
  typingGroups = {};
}

function groupTypingNames(groupName) {
  return typingGroups[groupName] ? [...typingGroups[groupName]] : [];
}

// Roughly scales with message length so a one-word reply lands fast
// and a longer one takes a beat longer, with a little randomness so
// it doesn't feel mechanical. Capped so nobody waits too long.
function typingDelayFor(text) {
  const base = 600;
  const perChar = 18;
  const jitter = Math.random() * 600;
  return Math.min(base + text.length * perChar + jitter, 3000);
}

function panelSkeleton() {
  return `
  <div id="phoneui-panel" class="phoneui-hidden">
    <div class="phoneui-frame">
      <div class="phoneui-statusbar" id="phoneui-statusbar"><span>9:41</span><i class="fa-solid fa-signal"></i></div>
      <div class="phoneui-body" id="phoneui-body"></div>
      <div class="phoneui-homebar">
        <div class="phoneui-homebtn" id="phoneui-homebtn" title="Home"></div>
      </div>
    </div>
  </div>`;
}

// The home screen: a grid of app icons (Texts, Feed, Discord,
// Contacts, Compose), same idea as a phone's springboard. Each icon
// carries its own unread badge where that's meaningful, instead of
// one combined count - lets you tell at a glance which app actually
// needs attention.
function renderHome() {
  const s = getSettings();
  const persona = currentPersonaName();
  const pendingInvites = (s.discordInvites || []).length;
  const unreadNotifs = (s.notifications || []).filter((n) => !n.read).length;
  const apps = [
    { tab: "texts", label: "Texts", icon: "fa-solid fa-comment", bg: "#2d5ea8", badge: s.unread || 0 },
    { tab: "feed", label: "Feed", icon: "fa-solid fa-images", bg: "#a83c3c" },
    { tab: "notifications", label: "Notifications", icon: "fa-solid fa-bell", bg: "#c77c1f", badge: unreadNotifs },
    { tab: "discord", label: "Discord", icon: "fa-brands fa-discord", bg: "#5865f2", badge: pendingInvites },
    { tab: "contacts", label: "Contacts", icon: "fa-solid fa-address-book", bg: "#3c8a5c" },
    { tab: "compose", label: "Compose", icon: "fa-solid fa-pen", bg: "#a8843c" },
  ];
  return `
  <div class="phoneui-homescreen">
    <div class="phoneui-homeprofile" data-openprofile="${escapeHtml(persona)}">
      ${avatarHtml(initials(persona), avatarPhotoFor(persona), "phoneui-avatar-sm")}
      <div class="phoneui-homeprofiletext">
        <div class="phoneui-homeprofilename">${escapeHtml(persona)}</div>
        <div class="phoneui-homeprofilesub">View your profile</div>
      </div>
      <i class="fa-solid fa-chevron-right"></i>
    </div>
    <div class="phoneui-homegrid">
      ${apps
        .map(
          (app) => `
        <div class="phoneui-appicon" data-tab="${app.tab}">
          <div class="phoneui-appicon-glyph" style="background:${app.bg}">
            <i class="${app.icon}"></i>
            ${app.badge ? `<span class="phoneui-appicon-badge">${app.badge > 99 ? "99+" : app.badge}</span>` : ""}
          </div>
          <span class="phoneui-appicon-label">${app.label}</span>
        </div>`
        )
        .join("")}
    </div>
  </div>`;
}

// Shared reset used both by the home button and anywhere else that
// needs to drop back to the springboard - clears whatever sub-view
// state (open thread, channel, story, gif picker...) belonged to
// whichever app was open, so returning to an app fresh later doesn't
// resume some stale in-progress state.
function goHome() {
  activeTab = "home";
  activeThread = null;
  activeGroup = null;
  activeServer = null;
  activeChannel = null;
  activeProfile = null;
  groupCreate = { open: false, name: "", selected: new Set() };
  gifPicker.open = false;
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  renderPanel();
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderCaption(caption) {
  return escapeHtml(caption)
    .replace(/#(\w+)/g, '<span class="phoneui-tag">#$1</span>')
    .replace(/@(\w+)/g, '<span class="phoneui-mention">@$1</span>');
}

// ---------------------------------------------------------------
// Read receipts (derived from the thread itself - no extra data to
// store: a user message counts as "seen" once anyone has replied
// after it, since in a text-roleplay context a reply implies the
// character read it)
// ---------------------------------------------------------------

function findLastUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].who === "user") return i;
  }
  return -1;
}

// 1:1 thread: "Delivered" until the contact sends anything after the
// user's last message, then "Seen".
function render1to1Receipt(msgs, lastUserIndex) {
  const seen = msgs.slice(lastUserIndex + 1).some((m) => m.who === "npc");
  return seen
    ? `<div class="phoneui-receipt"><i class="fa-solid fa-check-double"></i> Seen</div>`
    : `<div class="phoneui-receipt"><i class="fa-solid fa-check"></i> Delivered</div>`;
}

// Group thread: "Delivered" until at least one member has replied
// after the user's last message, then "Seen by <names who replied>"
// (or "Seen by all" once every member has).
function renderGroupReceipt(msgs, lastUserIndex, members) {
  const repliedAfter = new Set(
    msgs
      .slice(lastUserIndex + 1)
      .filter((m) => m.who === "npc")
      .map((m) => m.sender)
  );
  if (repliedAfter.size === 0) {
    return `<div class="phoneui-receipt"><i class="fa-solid fa-check"></i> Delivered</div>`;
  }
  const allSeen = members.every((mem) => repliedAfter.has(mem));
  const label = allSeen ? "Seen by all" : `Seen by ${[...repliedAfter].map((n) => escapeHtml(n)).join(", ")}`;
  return `<div class="phoneui-receipt"><i class="fa-solid fa-check-double"></i> ${label}</div>`;
}

// One "..." bubble per person currently typing. Group bubbles get a
// sender label above the dots, same as a real group message would.
function renderTypingBubble(sender) {
  return `<div class="phoneui-bubble phoneui-bubble-npc phoneui-typing">${
    sender ? `<div class="phoneui-bubblesender">${escapeHtml(sender)}</div>` : ""
  }<div class="phoneui-typingdots"><span></span><span></span><span></span></div></div>`;
}

function renderTexts() {
  const s = getSettings();

  // Group thread view
  if (activeGroup && s.groups[activeGroup]) {
    const group = s.groups[activeGroup];
    const msgs = s.groupThreads[activeGroup] || [];
    const lastUserIndex = findLastUserIndex(msgs);
    const typingNames = groupTypingNames(activeGroup);
    const headerSub = typingNames.length
      ? `<span class="phoneui-threadheadersub phoneui-typingsub">${
          typingNames.length === 1
            ? `${escapeHtml(typingNames[0])} is typing…`
            : `${typingNames.map((n) => escapeHtml(n)).join(", ")} are typing…`
        }</span>`
      : `<span class="phoneui-threadheadersub">${group.members.map((m) => escapeHtml(m)).join(", ")}</span>`;
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-back"></i>
        <div class="phoneui-avatar phoneui-groupavatar">${group.avatar}</div>
        <div class="phoneui-threadheadertext">
          <span>${escapeHtml(activeGroup)}</span>
          ${headerSub}
        </div>
      </div>
      <div class="phoneui-messages">
        ${msgs
          .map((m, i) => {
            const bubble = `<div class="phoneui-bubble ${m.who === "user" ? "phoneui-bubble-user" : "phoneui-bubble-npc"}">${
              m.who === "npc" ? `<div class="phoneui-bubblesender">${escapeHtml(m.sender)}</div>` : ""
            }${m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""}${
              m.text ? escapeHtml(m.text) : ""
            }</div>`;
            return i === lastUserIndex ? bubble + renderGroupReceipt(msgs, lastUserIndex, group.members) : bubble;
          })
          .join("")}
        ${typingNames.map((n) => renderTypingBubble(n)).join("")}
      </div>
      ${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-grouptextinput" placeholder="Message ${escapeHtml(activeGroup)}" value="${escapeHtml(
          messageDrafts.groups[activeGroup] || ""
        )}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-grouptextgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-grouptextsend"></i>
      </div>`;
  }

  // 1:1 thread view. Guard on the contact existing, not on a thread
  // already having messages - a contact who's never texted yet (added
  // by number, or opened via "Message" from their profile) still has
  // a valid, just-empty thread; msgs falls back to [] rather than
  // failing this check and silently dumping back to the thread list.
  if (activeThread && (s.threads[activeThread] || s.contacts[activeThread])) {
    const msgs = s.threads[activeThread] || [];
    const lastUserIndex = findLastUserIndex(msgs);
    const isTyping = typingThreads.has(activeThread);
    const contact = s.contacts[activeThread];
    const isUnknown = !!contact?.unknown;
    const isBlockedContact = !isUnknown && !!contact?.blocked;
    const contactPhone = contact?.phone;
    const headerLabel = displayName(activeThread, contact);
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-back"></i>
        <span class="phoneui-listidentity" ${!isUnknown ? `data-openprofile="${escapeHtml(activeThread)}"` : ""}>
        ${avatarHtml(contact?.avatar || "?", contact ? avatarPhotoFor(activeThread) : null)}
        <div class="phoneui-threadheadertext">
          <span>${escapeHtml(headerLabel)}</span>
          ${
            isTyping
              ? `<span class="phoneui-threadheadersub phoneui-typingsub">typing…</span>`
              : isUnknown
              ? `<span class="phoneui-threadheadersub">${escapeHtml(activeThread)}</span>`
              : contact?.nickname
              ? `<span class="phoneui-threadheadersub">${escapeHtml(activeThread)}${
                  contactPhone ? ` · ${escapeHtml(contactPhone)}` : ""
                }</span>`
              : contactPhone
              ? `<span class="phoneui-threadheadersub">${escapeHtml(contactPhone)}</span>`
              : ""
          }
        </div>
        </span>
        <div class="phoneui-threadheaderactions">
          <i class="fa-solid fa-camera" data-setphoto="${escapeHtml(activeThread)}" title="Set contact photo"></i>
          ${
            contact?.photo
              ? `<i class="fa-solid fa-image-slash" data-removephoto="${escapeHtml(
                  activeThread
                )}" title="Remove photo"></i>`
              : ""
          }
          <i class="fa-solid fa-pen" data-nickname="${escapeHtml(activeThread)}" title="Edit nickname"></i>
          ${
            !isUnknown
              ? `<i class="fa-solid fa-ban ${isBlockedContact ? "phoneui-blocked" : ""}" data-blocktoggle="${escapeHtml(
                  activeThread
                )}" title="${isBlockedContact ? "Unblock" : "Block/mute"}"></i>`
              : ""
          }
        </div>
      </div>
      ${
        isUnknown
          ? `<div class="phoneui-addcontact">
              <input type="text" id="phoneui-saveunknown" placeholder="Save as contact name" />
              <i class="fa-solid fa-check" id="phoneui-saveunknownbtn"></i>
            </div>`
          : ""
      }
      <div class="phoneui-messages">
        ${msgs
          .map((m, i) => {
            const bubble = `<div class="phoneui-bubble ${m.who === "user" ? "phoneui-bubble-user" : "phoneui-bubble-npc"}">${
              m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""
            }${m.text ? escapeHtml(m.text) : ""}</div>`;
            return i === lastUserIndex ? bubble + render1to1Receipt(msgs, lastUserIndex) : bubble;
          })
          .join("")}
        ${isTyping ? renderTypingBubble() : ""}
      </div>
      ${
        isBlockedContact
          ? `<div class="phoneui-blockednotice">You've blocked ${escapeHtml(
              activeThread
            )}. <button data-blocktoggle="${escapeHtml(activeThread)}">Unblock</button></div>`
          : `${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-textinput" placeholder="Message" value="${escapeHtml(
          messageDrafts.threads[activeThread] || ""
        )}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-textgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-textsend"></i>
      </div>`
      }`;
  }

  // New-group picker
  if (groupCreate.open) {
    const contactNames = visibleContactNames();
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-groupcreate-back"></i>
        <span>New group</span>
      </div>
      <div class="phoneui-addcontact">
        <input type="text" id="phoneui-groupname" placeholder="Group name" value="${escapeHtml(groupCreate.name)}" />
      </div>
      ${
        contactNames.length === 0
          ? `<div class="phoneui-empty">Add a contact first, then come back to start a group.</div>`
          : `<div class="phoneui-list">
              ${contactNames
                .map(
                  (n) => `<div class="phoneui-listitem phoneui-groupmemberitem" data-member="${escapeHtml(n)}">
                    ${avatarHtml(s.contacts[n].avatar, avatarPhotoFor(n))}
                    <div class="phoneui-listtext"><div class="phoneui-listname">${escapeHtml(
                      displayName(n, s.contacts[n])
                    )}</div></div>
                    <i class="fa-solid ${
                      groupCreate.selected.has(n) ? "fa-square-check" : "fa-square"
                    } phoneui-groupmembercheck"></i>
                  </div>`
                )
                .join("")}
            </div>
            <div class="phoneui-composerow" style="padding: 10px 14px;">
              <button id="phoneui-groupcreatebtn">Create group</button>
            </div>`
      }`;
  }

  // Combined list: groups, then 1:1 contacts
  const names = visibleContactNames();
  const groupNames = Object.keys(s.groups);
  if (names.length === 0 && groupNames.length === 0) {
    return `<div class="phoneui-empty">No conversations yet. Add a contact or wait for someone to text you.</div>`;
  }
  return `
    <div class="phoneui-textsheader">
      <span>Texts</span>
      <i class="fa-solid fa-user-group" id="phoneui-newgroupbtn" title="New group"></i>
    </div>
    <div class="phoneui-list">
    ${groupNames
      .map((n) => {
        const thread = s.groupThreads[n] || [];
        const last = thread[thread.length - 1];
        const lastText = last ? last.text || (last.gif ? "📷 GIF" : "") : "";
        const preview = last ? (last.who === "npc" ? `${last.sender}: ${lastText}` : lastText) : "No messages yet";
        const isTyping = groupTypingNames(n).length > 0;
        return `<div class="phoneui-listitem" data-group="${escapeHtml(n)}">
          <div class="phoneui-avatar phoneui-groupavatar">${s.groups[n].avatar}</div>
          <div class="phoneui-listtext">
            <div class="phoneui-listname">${escapeHtml(n)}</div>
            <div class="phoneui-listpreview${isTyping ? " phoneui-typingpreview" : ""}">${
              isTyping ? "typing…" : escapeHtml(preview.slice(0, 40))
            }</div>
          </div>
        </div>`;
      })
      .join("")}
    ${names
      .map((n) => {
        const thread = s.threads[n] || [];
        const last = thread[thread.length - 1];
        const isTyping = typingThreads.has(n);
        const c = s.contacts[n];
        const label = c.nickname
          ? c.nickname
          : c.unknown
          ? `Unknown · ${n}`
          : n;
        return `<div class="phoneui-listitem" data-contact="${escapeHtml(n)}">
          <span class="phoneui-avataropenprofile" ${!c.unknown ? `data-openprofile="${escapeHtml(n)}"` : ""}>${avatarHtml(c.avatar, avatarPhotoFor(n))}</span>
          <div class="phoneui-listtext">
            <div class="phoneui-listname">${escapeHtml(label)}</div>
            <div class="phoneui-listpreview${isTyping ? " phoneui-typingpreview" : ""}">${
              isTyping
                ? "typing…"
                : last
                ? escapeHtml((last.text || (last.gif ? "📷 GIF" : "")).slice(0, 40))
                : "No messages yet"
            }</div>
          </div>
        </div>`;
      })
      .join("")}
  </div>`;
}

// "recent" = plain reverse-chronological (the old behavior). "foryou"
// = ranked by scorePostForYou() - a lightweight discovery algorithm
// blending recency, existing engagement, and the user's own
// like/comment history. Not persisted - resets to "recent" each panel
// load, same as activeTab.
let feedSortMode = "recent";

function renderFeed() {
  const s = getSettings();
  const stories = renderStoriesStrip();
  const posts =
    feedSortMode === "foryou"
      ? [...s.feed].sort((a, b) => scorePostForYou(b, s) - scorePostForYou(a, s))
      : s.feed;
  const sortToggle = `
    <div class="phoneui-feedsort">
      <span class="phoneui-feedsort-opt ${feedSortMode === "recent" ? "phoneui-feedsort-active" : ""}" data-sortmode="recent">Recent</span>
      <span class="phoneui-feedsort-opt ${feedSortMode === "foryou" ? "phoneui-feedsort-active" : ""}" data-sortmode="foryou">For You</span>
    </div>`;
  const body =
    posts.length === 0
      ? `<div class="phoneui-empty">No posts yet. Be the first to post something.</div>`
      : `<div class="phoneui-feed">
    ${posts
      .map(
        (p) => `
      <div class="phoneui-post" data-postid="${p.id}">
        ${
          p.repostOf
            ? `<div class="phoneui-repostlabel"><i class="fa-solid fa-retweet"></i> ${escapeHtml(p.author)} reposted</div>`
            : ""
        }
        <div class="phoneui-postheader">
          <span class="phoneui-postheader-identity" data-openprofile="${escapeHtml(p.repostOf ? p.repostOf.author : p.author)}">
            ${avatarHtml(
              initials(p.repostOf ? p.repostOf.author : p.author),
              avatarPhotoFor(p.repostOf ? p.repostOf.author : p.author)
            )}
            <span class="phoneui-postauthor">${escapeHtml(p.repostOf ? p.repostOf.author : p.author)}</span>
          </span>
          <span class="phoneui-postheader-follow">${followLineHtml(p.repostOf ? p.repostOf.author : p.author)}</span>
        </div>
        ${
          p.repostOf
            ? `${
                p.repostOf.gif
                  ? `<img class="phoneui-postgif" src="${escapeHtml(p.repostOf.gif.url)}" alt="${escapeHtml(
                      p.repostOf.gif.title
                    )}" />`
                  : ""
              }${p.repostOf.caption ? `<div class="phoneui-postcaption">${renderCaption(p.repostOf.caption)}</div>` : ""}${
                p.caption ? `<div class="phoneui-repostcaption">${escapeHtml(p.author)}: ${renderCaption(p.caption)}</div>` : ""
              }`
            : `${p.gif ? `<img class="phoneui-postgif" src="${escapeHtml(p.gif.url)}" alt="${escapeHtml(p.gif.title)}" />` : ""}${
                p.caption ? `<div class="phoneui-postcaption">${renderCaption(p.caption)}</div>` : ""
              }`
        }
        <div class="phoneui-postactions">
          <i class="fa-solid fa-heart phoneui-like ${p.likedByUser ? "phoneui-liked" : ""}" data-postid="${p.id}"></i>
          <span>${p.likes}</span>
          <i class="fa-regular fa-comment"></i>
          <span>${p.comments.length}</span>
          <i class="fa-solid fa-retweet phoneui-repost" data-postid="${p.id}" title="Repost"></i>
          <span class="phoneui-postviews" title="Views"><i class="fa-regular fa-eye"></i> ${p.views || 0}</span>
        </div>
        ${p.comments
          .map(
            (c) =>
              `<div class="phoneui-comment">${
                c.replyTo ? `<span class="phoneui-commentreplytag">@${escapeHtml(c.replyTo)}</span> ` : ""
              }<b>${escapeHtml(c.author)}</b> ${escapeHtml(c.text)}</div>`
          )
          .join("")}
        <div class="phoneui-commentrow">
          <input type="text" class="phoneui-commentinput" data-postid="${p.id}" placeholder="Add a comment..." />
          <i class="fa-solid fa-paper-plane phoneui-commentsend" data-postid="${p.id}" title="Post comment"></i>
        </div>
      </div>`
      )
      .join("")}
  </div>`;
  return stories + sortToggle + body + renderStoryViewer();
}

function renderDiscord() {
  const s = getSettings();

  // Level 3: inside a channel
  if (activeServer && activeChannel && s.discordServers[activeServer]) {
    const server = s.discordServers[activeServer];
    const msgs = server.channels[activeChannel] || [];
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-discord-back-channel"></i>
        <span>#${escapeHtml(activeChannel)}</span>
      </div>
      <div class="phoneui-messages">
        ${msgs
          .map(
            (m) => `<div class="phoneui-dmsg ${m.isUser ? "phoneui-dmsg-user" : ""}">
              ${avatarHtml(initials(m.author), avatarPhotoFor(m.author), "phoneui-avatar-sm")}
              <div>
                <div class="phoneui-dauthor">${escapeHtml(m.author)}</div>
                ${m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""}
                ${m.text ? `<div class="phoneui-dtext">${escapeHtml(m.text)}</div>` : ""}
              </div>
            </div>`
          )
          .join("")}
      </div>
      ${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-discordinput" placeholder="Message #${escapeHtml(activeChannel)}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-discordgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-discordsend"></i>
      </div>`;
  }

  // Level 2: channel list inside a server
  if (activeServer && s.discordServers[activeServer]) {
    const server = s.discordServers[activeServer];
    const channelNames = Object.keys(server.channels);
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-discord-back-server"></i>
        <div class="phoneui-avatar">${server.icon}</div>
        <span>${escapeHtml(activeServer)}</span>
      </div>
      <div class="phoneui-channellist">
        ${channelNames
          .map(
            (c) => `<div class="phoneui-channelitem" data-channel="${escapeHtml(c)}">
              <i class="fa-solid fa-hashtag"></i><span>${escapeHtml(c)}</span>
            </div>`
          )
          .join("")}
      </div>
      <div class="phoneui-addcontact">
        <input type="text" id="phoneui-newchannel" placeholder="New channel name" />
        <i class="fa-solid fa-plus" id="phoneui-addchannelbtn"></i>
      </div>`;
  }

  // Level 1: server rail + pending invites
  const serverNames = Object.keys(s.discordServers);
  return `
    ${
      s.discordInvites.length > 0
        ? `<div class="phoneui-invites">
            ${s.discordInvites
              .map(
                (inv) => `<div class="phoneui-invitecard">
                  <div class="phoneui-invitetitle"><i class="fa-brands fa-discord"></i> ${escapeHtml(inv.from)} invited you to <b>${escapeHtml(inv.server)}</b></div>
                  <div class="phoneui-invitemsg">${escapeHtml(inv.message)}</div>
                  <div class="phoneui-inviteactions">
                    <button class="phoneui-inviteaccept" data-inviteid="${inv.id}">Accept</button>
                    <button class="phoneui-invitedecline" data-inviteid="${inv.id}">Decline</button>
                  </div>
                </div>`
              )
              .join("")}
          </div>`
        : ""
    }
    ${
      serverNames.length === 0
        ? `<div class="phoneui-empty">No servers yet. Wait for an invite, or add one below.</div>`
        : `<div class="phoneui-serverlist">
            ${serverNames
              .map(
                (n) => `<div class="phoneui-serveritem" data-server="${escapeHtml(n)}">
                  <div class="phoneui-avatar">${s.discordServers[n].icon}</div>
                  <span>${escapeHtml(n)}</span>
                </div>`
              )
              .join("")}
          </div>`
    }
    <div class="phoneui-addcontact">
      <input type="text" id="phoneui-newserver" placeholder="Join server by name" />
      <i class="fa-solid fa-plus" id="phoneui-addserverbtn"></i>
    </div>`;
}

// "3m", "2h", "5d" - compact relative timestamp for notification-center
// entries, phone-notification style rather than a full date/time.
function timeAgo(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return `${Math.floor(diffDay / 7)}w`;
}

function renderNotifications() {
  const s = getSettings();
  const list = s.notifications || [];
  if (list.length === 0) {
    return `<div class="phoneui-empty">No notifications yet. Follows, likes, comments, and mentions will show up here.</div>`;
  }
  return `<div class="phoneui-notiflist">
    ${list
      .map((n) => {
        const contact = s.contacts[n.actor];
        const label = displayName(n.actor, contact);
        const icon = NOTIF_ICON[n.type] || "fa-solid fa-bell";
        const message = notifTextFor(n.type, `<b>${escapeHtml(label)}</b>`);
        const extra = n.text ? `<div class="phoneui-notif-extra">${escapeHtml(n.text.slice(0, 100))}</div>` : "";
        return `<div class="phoneui-notif-item ${n.read ? "" : "phoneui-notif-unread"}" data-notifid="${n.id}" data-notiftype="${
          n.type
        }">
          <span class="phoneui-avataropenprofile" data-openprofile="${escapeHtml(n.actor)}">${avatarHtml(initials(n.actor), avatarPhotoFor(n.actor))}</span>
          <div class="phoneui-notif-body">
            <div class="phoneui-notif-icon-wrap"><i class="${icon} phoneui-notif-typeicon phoneui-notif-${n.type}"></i></div>
            <div class="phoneui-notif-text">
              <div>${message}</div>
              ${extra}
            </div>
          </div>
          <div class="phoneui-notif-time">${timeAgo(n.ts)}</div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderContacts() {
  const s = getSettings();
  const names = visibleContactNames();
  const persona = currentPersonaName();
  return `
    <div class="phoneui-addcontact">
      <input type="text" id="phoneui-newcontact" placeholder="Add contact by number" inputmode="tel" />
      <i class="fa-solid fa-plus" id="phoneui-addcontactbtn"></i>
    </div>
    <div class="phoneui-settings-hint phoneui-addcontacthint">
      Contacts can only be added by phone number - a name on its own
      isn't enough to text someone. Once you know who a number
      belongs to, give it a nickname below.
    </div>
    <div class="phoneui-list">
      ${names
        .map((n) => {
          const c = ensureContact(n);
          const phone = c.phone;
          const label = displayName(n, c);
          const showPhone = phone && !c.unknown; // unknown contacts already show their number as the name
          const isSelf = n === persona;
          const famousBadge = c.famous
            ? `<i class="fa-solid fa-certificate phoneui-verified" title="Well-known"></i>`
            : "";
          return `<div class="phoneui-listitem" data-contact="${escapeHtml(n)}">
            <span class="phoneui-avataropenprofile" ${!c.unknown ? `data-openprofile="${escapeHtml(n)}"` : ""}>${avatarHtml(c.avatar, avatarPhotoFor(n))}</span>
            <div class="phoneui-listtext">
              <div class="phoneui-listname">${escapeHtml(label)}</div>
              ${showPhone ? `<div class="phoneui-listphone">${escapeHtml(phone)}</div>` : ""}
              ${c.unknown ? `<div class="phoneui-listphone">${escapeHtml(n)}</div>` : ""}
              ${
                !c.unknown && !isSelf
                  ? `<div class="phoneui-listfollowers">${famousBadge}${formatFollowerCount(c.followerCount || 0)} followers</div>`
                  : ""
              }
            </div>
            ${
              !c.unknown && !isSelf
                ? `<button type="button" class="phoneui-followbtn phoneui-followbtn-sm ${
                    c.following ? "phoneui-following" : ""
                  }" data-follow="${escapeHtml(n)}">${c.following ? "Following" : "Follow"}</button>`
                : ""
            }
            ${
              showPhone
                ? `<i class="fa-solid fa-copy phoneui-copynumber" data-number="${escapeHtml(phone)}" title="Copy number"></i>`
                : ""
            }
            <i class="fa-solid fa-camera phoneui-editnickname" data-setphoto="${escapeHtml(n)}" title="Set contact photo"></i>
            <i class="fa-solid fa-pen phoneui-editnickname" data-nickname="${escapeHtml(n)}" title="Edit nickname"></i>
            <i class="fa-solid fa-ban phoneui-blocktoggle ${c.blocked ? "phoneui-blocked" : ""}" data-blocktoggle="${escapeHtml(
            n
          )}" title="${c.blocked ? "Unblock" : "Block"}"></i>
          </div>`;
        })
        .join("")}
    </div>`;
}

let composeGif = null;

function renderCompose() {
  const s = getSettings();
  // Same pool as the Contacts/Texts tabs (visibleContactNames): the
  // background random cast stays out of the quick-tag list unless
  // you've actually followed or messaged them - otherwise, at cast
  // sizes in the thousands, this dropdown would be almost entirely
  // unrecognizable strangers instead of a useful shortlist.
  const contactNames = visibleContactNames();
  return `
    <div class="phoneui-compose">
      <textarea id="phoneui-composetext" placeholder="What's happening? Use @ to tag someone, # to add a tag"></textarea>
      <div id="phoneui-mentionlist" class="phoneui-mentionlist phoneui-hidden">
        ${contactNames.map((n) => `<div class="phoneui-mentionopt" data-name="${escapeHtml(n)}">@${escapeHtml(n)}</div>`).join("")}
      </div>
      ${
        composeGif
          ? `<div class="phoneui-composegifpreview">
               <img src="${escapeHtml(composeGif.url)}" alt="${escapeHtml(composeGif.title)}" />
               <i class="fa-solid fa-xmark" id="phoneui-composegifremove" title="Remove GIF"></i>
             </div>`
          : ""
      }
      ${renderGifPicker()}
      <div class="phoneui-composerow">
        <button id="phoneui-composegifbtn" type="button"><i class="fa-solid fa-face-grin-squint"></i> Add GIF/meme</button>
        <button id="phoneui-postbtn">Post</button>
      </div>
    </div>`;
}

// Pulls a short "bio" line out of whatever character card data we can
// find for this contact (see findCharacterCardFor). Falls back to a
// plain placeholder when there's no linked card or it has nothing
// bio-shaped on it - this is best-effort flavor, not guaranteed data,
// since contacts here are just names pulled out of chat tags with no
// hard link back to an actual character object.
function bioFor(name) {
  const card = findCharacterCardFor(name);
  // Background/random-cast profiles (see ensureRandomCast) have no
  // character card behind them at all, so they get a short generated
  // bio at creation time instead - fall back to that when there's no
  // card match, rather than showing an empty bio for every one of them.
  const ambientBio = getSettings().contacts[name]?.bio || "";
  const raw = (card?.description || card?.personality || card?.creatorcomment || ambientBio || "").trim();
  if (!raw) return "";
  // Keep it profile-card sized rather than dumping a full character
  // description in - truncate on a word boundary.
  const maxLen = 220;
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

// This person's own original posts to the Feed (not their reposts of
// someone else's content - a profile grid showing "posts from them"
// reads as their own material, same convention as most social apps'
// profile tabs). Newest first, since a profile page is "their page"
// rather than a chronological timeline.
function postsBy(name) {
  const s = getSettings();
  return s.feed
    .filter((p) => p.author === name && !p.repostOf)
    .slice()
    .reverse();
}

function renderProfile(name) {
  const s = getSettings();
  const persona = currentPersonaName();
  const isSelf = name === persona;
  const c = isSelf ? null : ensureContact(name);
  const label = isSelf ? name : displayName(name, c);
  const avatarLabel = isSelf ? initials(name) : c?.avatar || initials(name);
  const famousBadge = c?.famous
    ? `<i class="fa-solid fa-certificate phoneui-verified" title="Well-known"></i>`
    : "";
  const bio = bioFor(name);
  const posts = postsBy(name);
  // The user doesn't have a rolled "follower count" the way NPCs do -
  // show how many contacts follow them back instead, which is the
  // closest real equivalent.
  const followerCountLabel = isSelf
    ? formatFollowerCount(Object.values(s.contacts || {}).filter((x) => x.followsUser).length)
    : formatFollowerCount(c?.followerCount || 0);

  return `
    <div class="phoneui-threadheader">
      <i class="fa-solid fa-chevron-left" id="phoneui-profile-back"></i>
      <span>Profile</span>
    </div>
    <div class="phoneui-profile">
      <div class="phoneui-profiletop">
        ${avatarHtml(avatarLabel, avatarPhotoFor(name), "phoneui-avatar-lg")}
        <div class="phoneui-profilename">${famousBadge}${escapeHtml(label)}</div>
        ${!isSelf && c?.unknown ? `<div class="phoneui-profilesub">${escapeHtml(name)}</div>` : ""}
        <div class="phoneui-profilestats">
          <span><b>${posts.length}</b> posts</span>
          <span><b>${followerCountLabel}</b> followers</span>
        </div>
        ${bio ? `<div class="phoneui-profilebio">${escapeHtml(bio)}</div>` : ""}
        ${
          !isSelf && !c?.unknown
            ? `<div class="phoneui-profileactions">
                <button type="button" class="phoneui-followbtn ${c.following ? "phoneui-following" : ""}" data-follow="${escapeHtml(
                name
              )}">${c.following ? "Following" : "Follow"}</button>
                <button type="button" class="phoneui-profilemsgbtn" data-profilemessage="${escapeHtml(name)}"><i class="fa-solid fa-comment"></i> Message</button>
              </div>`
            : ""
        }
      </div>
      <div class="phoneui-profileposts">
        ${
          posts.length === 0
            ? `<div class="phoneui-empty">${isSelf ? "You haven't" : escapeHtml(label) + " hasn't"} posted anything yet.</div>`
            : posts
                .map(
                  (p) => `
              <div class="phoneui-post" data-postid="${p.id}">
                ${p.gif ? `<img class="phoneui-postgif" src="${escapeHtml(p.gif.url)}" alt="${escapeHtml(p.gif.title)}" />` : ""}
                ${p.caption ? `<div class="phoneui-postcaption">${renderCaption(p.caption)}</div>` : ""}
                <div class="phoneui-postactions">
                  <i class="fa-solid fa-heart phoneui-like ${p.likedByUser ? "phoneui-liked" : ""}" data-postid="${p.id}"></i>
                  <span>${p.likes}</span>
                  <i class="fa-regular fa-comment"></i>
                  <span>${p.comments.length}</span>
                </div>
              </div>`
                )
                .join("")
        }
      </div>
    </div>`;
}

function renderPanel() {
  const body = document.querySelector("#phoneui-body");
  if (!body) return;
  if (activeProfile) {
    body.innerHTML = renderProfile(activeProfile);
    attachBodyListeners();
    return;
  }
  if (activeTab === "home") body.innerHTML = renderHome();
  else if (activeTab === "texts") body.innerHTML = renderTexts();
  else if (activeTab === "feed") body.innerHTML = renderFeed();
  else if (activeTab === "notifications") body.innerHTML = renderNotifications();
  else if (activeTab === "discord") body.innerHTML = renderDiscord();
  else if (activeTab === "contacts") body.innerHTML = renderContacts();
  else if (activeTab === "compose") body.innerHTML = renderCompose();
  attachBodyListeners();
}

function attachBodyListeners() {
  document.querySelectorAll(".phoneui-appicon[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = el.dataset.tab;
      activeThread = null;
      activeGroup = null;
      activeServer = null;
      activeChannel = null;
      activeProfile = null;
      groupCreate = { open: false, name: "", selected: new Set() };
      gifPicker.open = false;
      stopStoryTimer();
      storyViewer = { open: false, author: null, index: 0, timerId: null };
      renderPanel();
      // Opening Notifications clears its badge, same instinct as a
      // real phone - the badge exists to say "something happened",
      // and looking at the list is what acknowledges it.
      if (activeTab === "notifications") {
        const s = getSettings();
        const hadUnread = (s.notifications || []).some((n) => !n.read);
        if (hadUnread) {
          s.notifications.forEach((n) => (n.read = true));
          saveSettings();
          updateToggleBadge();
        }
      }
    });
  });

  document.querySelectorAll(".phoneui-notif-item[data-notifid]").forEach((el) => {
    el.addEventListener("click", () => {
      const s = getSettings();
      const entry = s.notifications.find((n) => n.id === el.dataset.notifid);
      if (entry && !entry.read) {
        entry.read = true;
        saveSettings();
        updateToggleBadge();
      }
      // Follow notifications point at the person, everything else
      // (like/comment/mention/repost) points at the post it's about.
      if (el.dataset.notiftype === "follow") {
        activeTab = "contacts";
      } else {
        activeTab = "feed";
      }
      renderPanel();
    });
  });

  document.querySelectorAll("[data-follow]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger a listitem's "open thread" click
      toggleFollow(el.dataset.follow);
    });
  });

  document.querySelector("#phoneui-profile-back")?.addEventListener("click", () => {
    activeProfile = null;
    renderPanel();
  });

  document.querySelectorAll("[data-profilemessage]").forEach((el) => {
    el.addEventListener("click", () => {
      activeThread = el.dataset.profilemessage;
      activeGroup = null;
      activeProfile = null;
      activeTab = "texts";
      renderPanel();
    });
  });

  // Any avatar/name tagged data-openprofile jumps to that person's
  // profile page - used from the Feed post header, Contacts/Texts
  // lists, thread headers, and Notifications. stopPropagation so it
  // doesn't also fire a containing row's own click (e.g. opening the
  // thread from a Contacts list item).
  document.querySelectorAll("[data-openprofile]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = el.dataset.openprofile;
      if (!name) return;
      const s = getSettings();
      if (s.contacts[name]?.unknown) return; // nothing to show for an unresolved number
      activeProfile = name;
      renderPanel();
    });
  });

  document.querySelectorAll(".phoneui-listitem[data-contact]").forEach((el) => {
    el.addEventListener("click", () => {
      activeThread = el.dataset.contact;
      activeGroup = null;
      activeTab = "texts";
      renderPanel();
    });
  });

  document.querySelectorAll(".phoneui-listitem[data-group]").forEach((el) => {
    el.addEventListener("click", () => {
      activeGroup = el.dataset.group;
      activeThread = null;
      renderPanel();
    });
  });

  document.querySelector("#phoneui-newgroupbtn")?.addEventListener("click", () => {
    groupCreate = { open: true, name: "", selected: new Set() };
    renderPanel();
  });

  document.querySelector("#phoneui-groupcreate-back")?.addEventListener("click", () => {
    groupCreate = { open: false, name: "", selected: new Set() };
    renderPanel();
  });

  document.querySelector("#phoneui-groupname")?.addEventListener("input", (e) => {
    groupCreate.name = e.target.value; // stored, not re-rendered, so typing keeps focus
  });

  document.querySelectorAll(".phoneui-groupmemberitem").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.dataset.member;
      if (groupCreate.selected.has(name)) groupCreate.selected.delete(name);
      else groupCreate.selected.add(name);
      renderPanel();
    });
  });

  document.querySelector("#phoneui-groupcreatebtn")?.addEventListener("click", () => {
    const nameInput = document.querySelector("#phoneui-groupname");
    const name = (nameInput ? nameInput.value : groupCreate.name).trim();
    if (!name || groupCreate.selected.size < 2) {
      alert("Give the group a name and pick at least 2 people.");
      return;
    }
    ensureGroup(name, [...groupCreate.selected]);
    saveSettings();
    groupCreate = { open: false, name: "", selected: new Set() };
    activeGroup = name;
    renderPanel();
  });

  document.querySelector("#phoneui-back")?.addEventListener("click", () => {
    activeThread = null;
    activeGroup = null;
    gifPicker.open = false;
    renderPanel();
  });

  document.querySelector("#phoneui-grouptextsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-grouptextinput");
    if (input && input.value.trim() && activeGroup) {
      userSendGroupText(activeGroup, input.value.trim());
      input.value = "";
      delete messageDrafts.groups[activeGroup];
    }
  });
  document.querySelector("#phoneui-grouptextinput")?.addEventListener("input", (e) => {
    if (activeGroup) messageDrafts.groups[activeGroup] = e.target.value; // stored, not re-rendered, so typing keeps focus
  });
  document.querySelector("#phoneui-grouptextinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-grouptextsend")?.click();
  });
  document.querySelector("#phoneui-grouptextgifbtn")?.addEventListener("click", () => {
    const group = activeGroup;
    if (!group) return;
    openGifPicker((gif) => userSendGroupText(group, "", gif));
  });

  // --- Stories ---
  document.querySelectorAll(".phoneui-story").forEach((el) => {
    el.addEventListener("click", () => openStoryViewer(el.dataset.storyauthor));
  });
  document.querySelector("#phoneui-storyclose")?.addEventListener("click", closeStoryViewer);
  document.querySelector("#phoneui-storyprev")?.addEventListener("click", () => advanceStory(-1));
  document.querySelector("#phoneui-storynext")?.addEventListener("click", () => advanceStory(1));
  document.querySelector("#phoneui-storyreplyinput")?.addEventListener("input", (e) => {
    storyReplyDraft = e.target.value; // stored, not re-rendered, so typing keeps focus
    stopStoryTimer(); // pause auto-advance while composing a reply
  });
  document.querySelector("#phoneui-storyreplyinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-storyreplysend")?.click();
  });
  document.querySelector("#phoneui-storyreplysend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-storyreplyinput");
    if (input) replyToStory(input.value);
  });
  scheduleStoryAdvance();

  document.querySelector("#phoneui-textsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-textinput");
    if (input && input.value.trim() && activeThread) {
      userSendText(activeThread, input.value.trim());
      input.value = "";
      delete messageDrafts.threads[activeThread];
    }
  });
  document.querySelector("#phoneui-textinput")?.addEventListener("input", (e) => {
    if (activeThread) messageDrafts.threads[activeThread] = e.target.value; // stored, not re-rendered, so typing keeps focus
  });
  document.querySelector("#phoneui-textinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-textsend")?.click();
  });
  document.querySelector("#phoneui-textgifbtn")?.addEventListener("click", () => {
    const thread = activeThread;
    if (!thread) return;
    openGifPicker((gif) => userSendText(thread, "", gif));
  });

  document.querySelectorAll(".phoneui-like").forEach((el) => {
    el.addEventListener("click", () => toggleLike(el.dataset.postid));
  });

  document.querySelectorAll(".phoneui-repost").forEach((el) => {
    el.addEventListener("click", () => userRepost(el.dataset.postid));
  });

  // Any block/unblock control anywhere in the panel (thread header,
  // blocked-notice banner, contacts list) shares this one handler.
  document.querySelectorAll("[data-blocktoggle]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger a listitem's "open thread" click
      toggleBlock(el.dataset.blocktoggle);
    });
  });

  // Same idea for the nickname-edit pencil, wherever it shows up
  // (contacts list, thread header).
  document.querySelectorAll("[data-nickname]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setNickname(el.dataset.nickname);
    });
  });

  // Contact photo controls - same "shows up in multiple places"
  // pattern as block/nickname above.
  document.querySelectorAll("[data-setphoto]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setContactPhoto(el.dataset.setphoto);
    });
  });
  document.querySelectorAll("[data-removephoto]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeContactPhoto(el.dataset.removephoto);
    });
  });

  document.querySelector("#phoneui-saveunknownbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-saveunknown");
    const name = input ? input.value.trim() : "";
    if (name && activeThread) resolveUnknownNumber(activeThread, name);
  });
  document.querySelector("#phoneui-saveunknown")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-saveunknownbtn")?.click();
  });

  document.querySelectorAll(".phoneui-commentinput").forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && el.value.trim()) {
        userComment(el.dataset.postid, el.value.trim());
      }
    });
  });
  document.querySelectorAll(".phoneui-commentsend").forEach((el) => {
    el.addEventListener("click", () => {
      const input = document.querySelector(`.phoneui-commentinput[data-postid="${el.dataset.postid}"]`);
      const text = input ? input.value.trim() : "";
      if (text) userComment(el.dataset.postid, text);
    });
  });
  document.querySelectorAll(".phoneui-feedsort-opt").forEach((el) => {
    el.addEventListener("click", () => {
      feedSortMode = el.dataset.sortmode;
      renderPanel();
    });
  });

  // --- Discord: level 1 (server rail / invites) ---
  document.querySelectorAll(".phoneui-inviteaccept").forEach((el) => {
    el.addEventListener("click", () => acceptInvite(el.dataset.inviteid));
  });
  document.querySelectorAll(".phoneui-invitedecline").forEach((el) => {
    el.addEventListener("click", () => declineInvite(el.dataset.inviteid));
  });
  document.querySelectorAll(".phoneui-serveritem").forEach((el) => {
    el.addEventListener("click", () => {
      activeServer = el.dataset.server;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-addserverbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newserver");
    if (input && input.value.trim()) {
      ensureServer(input.value.trim());
      saveSettings();
      renderPanel();
    }
  });

  // --- Discord: level 2 (channel list) ---
  document.querySelector("#phoneui-discord-back-server")?.addEventListener("click", () => {
    activeServer = null;
    gifPicker.open = false;
    renderPanel();
  });
  document.querySelectorAll(".phoneui-channelitem").forEach((el) => {
    el.addEventListener("click", () => {
      activeChannel = el.dataset.channel;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-addchannelbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newchannel");
    const s = getSettings();
    if (input && input.value.trim() && activeServer) {
      const chan = input.value.trim().toLowerCase().replace(/\s+/g, "-");
      if (!s.discordServers[activeServer].channels[chan]) {
        s.discordServers[activeServer].channels[chan] = [];
      }
      saveSettings();
      renderPanel();
    }
  });

  // --- Discord: level 3 (channel chat) ---
  document.querySelector("#phoneui-discord-back-channel")?.addEventListener("click", () => {
    activeChannel = null;
    gifPicker.open = false;
    renderPanel();
  });
  document.querySelector("#phoneui-discordsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-discordinput");
    if (input && input.value.trim() && activeServer && activeChannel) {
      userSendDiscordMessage(activeServer, activeChannel, input.value.trim());
      input.value = "";
    }
  });
  document.querySelector("#phoneui-discordinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-discordsend")?.click();
  });
  document.querySelector("#phoneui-discordgifbtn")?.addEventListener("click", () => {
    const server = activeServer;
    const channel = activeChannel;
    if (!server || !channel) return;
    openGifPicker((gif) => userSendDiscordMessage(server, channel, "", gif));
  });

  document.querySelector("#phoneui-addcontactbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newcontact");
    const raw = input ? input.value.trim() : "";
    if (!raw) return;
    // Bug fix / feature: this used to let the user type any name and
    // instantly create a fully-named contact with no number at all -
    // there was nothing to actually text. A real phone only lets you
    // add someone by number, then optionally attach a name/nickname
    // once you know who it is - so require that here too. If the
    // model later reveals whose number this is via [NUMBER:Name], the
    // unknown thread automatically folds into that named contact.
    if (!isValidPhoneNumber(raw)) {
      alert("Enter a valid phone number, e.g. (555) 019-2847.");
      return;
    }
    const number = formatPhoneNumber(raw);
    const existing = findContactNameByPhone(number, null);
    if (existing) {
      // Already a contact (named or unknown) - just jump to them
      // instead of creating a duplicate entry for the same number.
      activeTab = "texts";
      activeThread = existing;
    } else {
      ensureUnknownContact(number);
    }
    if (input) input.value = "";
    saveSettings();
    renderPanel();
  });

  document.querySelectorAll(".phoneui-copynumber").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger the listitem's "open thread" click
      const num = el.dataset.number;
      if (!num || !navigator.clipboard?.writeText) return;
      navigator.clipboard
        .writeText(num)
        .then(() => {
          el.classList.remove("fa-copy");
          el.classList.add("fa-check", "phoneui-copied");
          setTimeout(() => {
            el.classList.remove("fa-check", "phoneui-copied");
            el.classList.add("fa-copy");
          }, 1200);
        })
        .catch(() => {});
    });
  });

  const composeText = document.querySelector("#phoneui-composetext");
  const mentionList = document.querySelector("#phoneui-mentionlist");
  composeText?.addEventListener("input", () => {
    const val = composeText.value;
    const atIndex = val.lastIndexOf("@");
    if (atIndex !== -1 && atIndex === val.length - 1) {
      mentionList?.classList.remove("phoneui-hidden");
    } else {
      mentionList?.classList.add("phoneui-hidden");
    }
  });
  document.querySelectorAll(".phoneui-mentionopt").forEach((el) => {
    el.addEventListener("click", () => {
      composeText.value += `${el.dataset.name} `;
      mentionList?.classList.add("phoneui-hidden");
      composeText.focus();
    });
  });
  document.querySelector("#phoneui-postbtn")?.addEventListener("click", () => {
    const caption = composeText.value.trim();
    if (caption || composeGif) {
      userSendPost(caption, composeGif);
      composeText.value = "";
      composeGif = null;
      activeTab = "feed";
      renderPanel();
    }
  });
  document.querySelector("#phoneui-composegifbtn")?.addEventListener("click", () => {
    openGifPicker((gif) => {
      composeGif = gif;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-composegifremove")?.addEventListener("click", () => {
    composeGif = null;
    renderPanel();
  });

  attachGifPickerListeners();
}

function updateToggleBadge() {
  const s = getSettings();
  const badge = document.querySelector("#phoneui-badge");
  if (!badge) return;
  const unreadNotifs = (s.notifications || []).filter((n) => !n.read).length;
  const total = (s.unread || 0) + unreadNotifs;
  // Set display inline directly rather than toggling a class: the
  // badge's base styles (see ensureToggleStylesInjected) are marked
  // !important on purpose, so a stylesheet class couldn't override
  // them anyway - inline is the only thing that reliably can.
  if (total > 0) {
    badge.textContent = total;
    badge.style.setProperty("display", "flex", "important");
    badge.style.setProperty("align-items", "center", "important");
    badge.style.setProperty("justify-content", "center", "important");
  } else {
    badge.style.setProperty("display", "none", "important");
  }
}

// Applies a saved manual panel drag position (if any), the same way
// applyTogglePosition does for the button. Measures the panel the
// same "briefly unhide while invisible" way positionPanelNearButton
// does, since it too may currently be display:none.
function applyPanelPosition(pos) {
  const panel = document.querySelector("#phoneui-panel");
  if (!panel) return;
  const wasHidden = panel.classList.contains("phoneui-hidden");
  if (wasHidden) {
    panel.style.setProperty("visibility", "hidden", "important");
    panel.classList.remove("phoneui-hidden");
  }
  const w = panel.offsetWidth || 320;
  const h = panel.offsetHeight || 560;
  if (wasHidden) {
    panel.classList.add("phoneui-hidden");
    panel.style.removeProperty("visibility");
  }
  const { left, top } = clampTogglePosition(pos.left, pos.top, w, h);
  panel.style.setProperty("left", `${left}px`, "important");
  panel.style.setProperty("top", `${top}px`, "important");
  panel.style.setProperty("right", "auto", "important");
  panel.style.setProperty("bottom", "auto", "important");
  panel.style.setProperty("transform", "none", "important");
}

// Decides how to place the panel right before it opens: a manually
// dragged spot (sticky, set by dragging the panel itself) wins if one
// exists; otherwise it auto-follows the toggle button.
function positionPanelForOpen() {
  const s = getSettings();
  if (s.panelPos) applyPanelPosition(s.panelPos);
  else positionPanelNearButton();
}

// Pointer-based dragging for the panel itself, grabbed by its status
// bar (mirrors attachToggleDragHandlers above). Once dragged, the panel's
// position becomes a sticky preference (saved as panelPos) that no
// longer auto-follows the button - drag the button and the panel
// stays put; drag the panel again to move it, or use "Reset
// button/panel position" in settings to go back to auto-follow.
function makePanelDraggable(panel, handle) {
  const DRAG_THRESHOLD = 6;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;

  handle.style.cursor = "grab";
  handle.style.touchAction = "none";
  handle.title = "Drag to move the phone";

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    dragging = false;
    handle.setPointerCapture(pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    handle.style.cursor = "grabbing";
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const { left, top } = clampTogglePosition(originLeft + dx, originTop + dy, w, h);
    panel.style.setProperty("left", `${left}px`, "important");
    panel.style.setProperty("top", `${top}px`, "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform", "none", "important");
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    handle.style.cursor = "grab";
    if (dragging) {
      const rect = panel.getBoundingClientRect();
      const s = getSettings();
      s.panelPos = { left: rect.left, top: rect.top };
      saveSettings();
    }
    pointerId = null;
    dragging = false;
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function togglePanel() {
  const panel = document.querySelector("#phoneui-panel");
  const isHidden = panel.classList.contains("phoneui-hidden");
  if (isHidden) {
    // Compute position before revealing, so it appears already in the
    // right spot instead of flashing at an old location first.
    positionPanelForOpen();
    panel.classList.remove("phoneui-hidden");
    const s = getSettings();
    s.unread = 0;
    saveSettings();
    updateToggleBadge();
    renderPanel();
  } else {
    panel.classList.add("phoneui-hidden");
    stopStoryTimer();
  }
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------

function injectNotificationContainer() {
  const container = document.createElement("div");
  container.id = "phoneui-notifications";
  document.body.appendChild(container);
}

// Belt-and-suspenders: some SillyTavern layouts (especially mobile)
// apply CSS to <body> or intermediate wrappers - e.g. transforms used
// by swipe/drawer libraries - that can silently break `position:
// fixed` positioning for anything nested inside them, or can cause a
// stylesheet rule to unexpectedly win the cascade. Setting the
// critical positioning properties inline (with !important) sidesteps
// both problems: inline styles beat any external stylesheet, and
// appending straight to <html> instead of <body> keeps this element
// outside whatever wrapper ST is transforming.
// Beyond position/z-index, force every CSS property that a host page
// (or a future ST theme) could plausibly use to hide an unrelated
// element by ID/selector collision or a blanket rule: display,
// visibility, opacity, and pointer-events. Inline !important beats
// any external stylesheet rule (even one that's also !important), so
// this is a hard guarantee the button can't be silently switched off
// by CSS elsewhere on the page.
// Forces position/stacking/interactivity so host-page CSS can't bury
// or block the button/panel. Deliberately does NOT force `display` -
// that's what .phoneui-hidden (display:none !important) controls for
// showing/hiding the panel, and an inline !important display here
// would always outrank that class rule, permanently pinning the
// panel visible and breaking the open/close toggle entirely.
function forceFixedStyle(el) {
  el.style.setProperty("position", "fixed", "important");
  el.style.setProperty("z-index", "2147483000", "important");
  el.style.setProperty("visibility", "visible", "important");
  el.style.setProperty("opacity", "1", "important");
  el.style.setProperty("pointer-events", "auto", "important");
}

// A simple line-art phone glyph, drawn as inline SVG instead of an
// icon-font glyph. Icon fonts (Font Awesome here) can render as an
// empty box if the host page ships a different FA version that's
// missing the specific icon name, hasn't finished loading its
// stylesheet yet, or blocks the @font-face request entirely - in any
// of those cases the button's dark circle still shows, but with
// nothing on it, which reads as "invisible". Inline SVG has no
// external dependency: it's either in the DOM and painted, or it
// isn't there at all, which is much easier to debug if something
// still goes wrong.
const PHONE_SVG = `
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    <rect x="6.5" y="2" width="11" height="20" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <line x1="9" y1="4.6" x2="15" y2="4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="12" cy="18.6" r="1.1" fill="currentColor"/>
  </svg>`;

let toggleResizeListenerStarted = false;

// Keeps a dragged position on-screen after a window/viewport resize
// (e.g. rotating a phone, or resizing a desktop browser) instead of
// letting it drift off the visible area, which would be another way
// for the button to effectively "disappear".
function clampTogglePosition(left, top, w, h) {
  const maxLeft = Math.max(0, window.innerWidth - w);
  const maxTop = Math.max(0, window.innerHeight - h);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

// Applies a saved drag position (if any) as inline left/top and
// clears the default right/bottom/transform positioning so they
// can't fight with it - including the mobile media-query rule, which
// inline !important always wins over.
function applyTogglePosition(wrapper) {
  const s = getSettings();
  if (!s.togglePos) return;
  const w = wrapper.offsetWidth || 52;
  const h = wrapper.offsetHeight || 52;
  const { left, top } = clampTogglePosition(s.togglePos.left, s.togglePos.top, w, h);
  wrapper.style.setProperty("left", left + "px", "important");
  wrapper.style.setProperty("top", top + "px", "important");
  wrapper.style.setProperty("right", "auto", "important");
  wrapper.style.setProperty("bottom", "auto", "important");
  wrapper.style.setProperty("transform", "none", "important");
}

// The panel used to sit at its own fixed bottom-right CSS position,
// completely independent of wherever the toggle button actually was
// (default spot, or dragged elsewhere). That's why dragging the
// button left it "behind the phone" - the panel would open in its
// old spot regardless, and could easily land right on top of the
// button instead of next to it. This anchors the panel to the
// button's *current* on-screen position instead, like a popover:
// opens above it if there's room, below it otherwise, and is clamped
// so it can never run off-screen.
function positionPanelNearButton() {
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  if (!wrapper || !panel) return;

  const btnRect = wrapper.getBoundingClientRect();

  // The panel needs real dimensions to measure, but it's normally
  // display:none while closed. Make it measurable without letting it
  // actually flash on screen mid-measurement.
  const wasHidden = panel.classList.contains("phoneui-hidden");
  if (wasHidden) {
    panel.style.setProperty("visibility", "hidden", "important");
    panel.classList.remove("phoneui-hidden");
  }
  const panelW = panel.offsetWidth;
  const panelH = panel.offsetHeight;
  if (wasHidden) {
    panel.classList.add("phoneui-hidden");
    panel.style.removeProperty("visibility");
  }
  if (!panelW || !panelH) return; // couldn't measure - leave existing position alone

  const margin = 12;
  const spaceAbove = btnRect.top;
  const spaceBelow = window.innerHeight - btnRect.bottom;

  const top =
    spaceAbove >= panelH + margin || spaceAbove > spaceBelow
      ? btnRect.top - panelH - margin
      : btnRect.bottom + margin;

  // Horizontally, hug the button's right edge like a popover, then
  // clamp fully on-screen so it can't hang off either edge.
  const left = btnRect.right - panelW;

  const clampedLeft = Math.min(Math.max(margin, left), window.innerWidth - panelW - margin);
  const clampedTop = Math.min(Math.max(margin, top), window.innerHeight - panelH - margin);

  panel.style.setProperty("left", `${clampedLeft}px`, "important");
  panel.style.setProperty("top", `${clampedTop}px`, "important");
  panel.style.setProperty("right", "auto", "important");
  panel.style.setProperty("bottom", "auto", "important");
  panel.style.setProperty("transform", "none", "important");
}

// Pointer-based dragging for the toggle button (mouse, touch, pen -
// one event set covers all three). A few pixels of movement have to
// happen before this counts as a drag rather than a tap, so the plain
// click handler that opens the panel still fires normally.
function attachToggleDragHandlers(wrapper, btn) {
  const DRAG_THRESHOLD = 6;
  let pointerId = null;
  let start = null;
  let origin = null;
  let dragging = false;

  btn.style.cursor = "grab";
  btn.style.touchAction = "none";

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    const rect = wrapper.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY };
    origin = { left: rect.left, top: rect.top };
    dragging = false;
    btn.setPointerCapture(pointerId);
  });

  btn.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    btn.style.cursor = "grabbing";
    const { left, top } = clampTogglePosition(origin.left + dx, origin.top + dy, wrapper.offsetWidth, wrapper.offsetHeight);
    wrapper.style.setProperty("left", left + "px", "important");
    wrapper.style.setProperty("top", top + "px", "important");
    wrapper.style.setProperty("right", "auto", "important");
    wrapper.style.setProperty("bottom", "auto", "important");
    wrapper.style.setProperty("transform", "none", "important");
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    btn.style.cursor = "grab";
    if (dragging) {
      // A drag shouldn't also fire the click that opens the panel.
      const swallowClick = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
        btn.removeEventListener("click", swallowClick, true);
      };
      btn.addEventListener("click", swallowClick, true);

      const rect = wrapper.getBoundingClientRect();
      const s = getSettings();
      s.togglePos = { left: rect.left, top: rect.top };
      saveSettings();
      const panel = document.querySelector("#phoneui-panel");
      if (panel && !panel.classList.contains("phoneui-hidden") && !s.panelPos) positionPanelNearButton();
    }
    pointerId = null;
    dragging = false;
  };
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  if (!toggleResizeListenerStarted) {
    toggleResizeListenerStarted = true;
    window.addEventListener("resize", () => {
      const w = document.querySelector("#phoneui-togglewrap");
      if (w && w.style.left) {
        applyTogglePosition(w);
      } else if (w) {
        const pos = computeDefaultTogglePosition();
        w.style.setProperty("bottom", pos.bottom, "important");
        w.style.setProperty("right", pos.right, "important");
      }
      const panel = document.querySelector("#phoneui-panel");
      if (panel && !panel.classList.contains("phoneui-hidden")) {
        const gs = getSettings();
        if (gs.panelPos) applyPanelPosition(gs.panelPos);
        else positionPanelNearButton();
      }
    });
  }
}

// Runs after mount, and again every guardian tick, to actually check
// the button ended up visible and clickable - not just assume the
// styles took. Unlike a check that only logs a console warning (which
// is invisible to anyone who never opens devtools - effectively a
// silent failure from the user's point of view), this one actively
// fixes what it finds: re-asserts the forced style properties, snaps
// back to the default corner if the button drifted off-screen, and
// only as a last resort - if the button is still missing from the DOM
// entirely after a fix attempt - surfaces an on-screen banner so the
// failure is visible without needing the console. Returns true if the
// button is confirmed healthy.
let toggleHealthBannerShown = false;
function checkAndRepairToggleHealth() {
  const wrapper = document.querySelector("#phoneui-togglewrap");
  if (!wrapper) {
    mountPhoneToggleButton();
    return false;
  }

  forceFixedStyle(wrapper);
  const btn = wrapper.querySelector(".phoneui-togglebtn");
  if (btn) forceFixedStyle(btn);

  const rect = wrapper.getBoundingClientRect();
  const offscreen =
    rect.width === 0 ||
    rect.height === 0 ||
    rect.right < 0 ||
    rect.left > window.innerWidth ||
    rect.bottom < 0 ||
    rect.top > window.innerHeight;

  if (offscreen) {
    // Drifted somewhere unreachable (e.g. a saved drag position from
    // a much larger screen) - reset to the default corner rather than
    // leaving it stuck out of view.
    const s = getSettings();
    s.togglePos = null;
    saveSettings();
    wrapper.style.removeProperty("left");
    wrapper.style.removeProperty("top");
    const pos = computeDefaultTogglePosition();
    wrapper.style.setProperty("bottom", pos.bottom, "important");
    wrapper.style.setProperty("right", pos.right, "important");
    wrapper.style.setProperty("transform", "none", "important");
  }

  // Confirm the button is actually the thing painted at its own
  // center point - if some other element sits on top of it despite
  // the z-index (a new stacking context from a host-page `filter` or
  // `transform` ancestor, most likely), bump it as high as the
  // platform allows one more time.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const topEl = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(cx, cy) : null;
  if (topEl && !wrapper.contains(topEl)) {
    wrapper.style.setProperty("z-index", "2147483647", "important");
  }

  return true;
}

// The button/panel deliberately float at a very high z-index so
// nothing in the chat UI can bury them (see forceFixedStyle above).
// That's correct for normal chat content, but it also means they'd
// sit on top of SillyTavern's *own* UI - the extensions/settings
// drawer, character panel, world info editor, confirmation popups,
// etc. - blocking clicks on it. That's specifically what was
// happening: opening ST's settings put the phone button/panel right
// over the top of it.
//
// Fix: detect when one of ST's own drawers or popups is open and
// drop the phone's stacking down near the bottom (and make it
// click-through) for as long as that's the case, restoring it the
// moment ST's UI closes again. This doesn't depend on knowing ST's
// exact z-index scheme - it works regardless of what that is.
// An element's own width/height (used below) reflect its layout box
// only - a `transform` (e.g. translateX(-100%) to slide a closed
// drawer off-screen) doesn't change that box at all, it just moves
// where it's painted. So a drawer "closed" that way still reports a
// non-zero width/height and passes a display/visibility/opacity/size
// check, while being entirely outside the viewport. Requiring actual
// viewport intersection closes that gap.
function isOnScreen(rect) {
  return rect.width > 0 && rect.height > 0 &&
    rect.right > 0 && rect.left < window.innerWidth &&
    rect.bottom > 0 && rect.top < window.innerHeight;
}

function isSillyTavernOverlayOpen() {
  // Right-nav / left-nav drawers (Extensions, User Settings, Character
  // Management, World Info, Persona, API Connections, ...) all share
  // this same "drawer-content" + "openDrawer" convention when open.
  // Some ST builds don't remove the "openDrawer" class when the
  // drawer closes - they just animate/hide it instead - so a class
  // check alone can get permanently stuck "open" the first time the
  // user ever opens one, silently burying the phone button behind
  // the page for the rest of the session. Require the matched element
  // to actually be visible, not just still carrying the class.
  //
  // Bug fix #1: "visible" used to mean display/visibility/opacity only.
  // Several ST themes collapse a closed drawer via height/max-height
  // instead of display:none, so a closed drawer still had
  // display:block, visibility:visible and opacity:1 - just zero
  // height. That made this permanently (mis)report "open" the moment
  // the user so much as glanced at a drawer once, which yields the
  // toggle button's z-index down to 1 for the rest of the session -
  // it's still in the DOM and positioned correctly, it just silently
  // renders underneath the rest of the page from then on.
  //
  // Bug fix #2: some other themes instead close a drawer by sliding it
  // off-screen with a CSS transform (e.g. translateX(-100%)), which
  // doesn't touch its width/height at all - only where it's painted.
  // That slipped past the fix above the same way: non-zero size, so
  // it still read as "open" forever after the first open/close. Now
  // checked via isOnScreen(), which additionally requires the drawer's
  // painted position to actually intersect the viewport.
  const drawer = document.querySelector(".drawer-content.openDrawer");
  if (drawer) {
    const cs = getComputedStyle(drawer);
    const rect = drawer.getBoundingClientRect();
    if (cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0 && isOnScreen(rect)) {
      return true;
    }
  }
  // ST's popup()/confirmation-dialog system renders inside this
  // backdrop, hidden via display:none when nothing is showing.
  const shadow = document.querySelector("#shadow_popup");
  if (shadow) {
    const cs = getComputedStyle(shadow);
    const rect = shadow.getBoundingClientRect();
    if (cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0 && isOnScreen(rect)) {
      return true;
    }
  }
  return false;
}

let stOverlayYielding = false;
function updateSTOverlayYield() {
  const shouldYield = isSillyTavernOverlayOpen();
  stOverlayYielding = shouldYield;
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  // Always (re-)apply rather than short-circuiting on "no change":
  // the toggle-button watchdog can recreate the wrapper element at
  // any time (e.g. after ST wipes and re-renders part of the DOM),
  // and a fresh element wouldn't have last tick's inline styles even
  // though our yielding/not-yielding *state* hasn't changed.
  [wrapper, panel].forEach((el) => {
    if (!el) return;
    if (shouldYield) {
      el.style.setProperty("z-index", "1", "important");
      el.style.setProperty("pointer-events", "none", "important");
    } else {
      el.style.setProperty("z-index", "2147483000", "important");
      el.style.setProperty("pointer-events", "auto", "important");
    }
  });
}

let stOverlayWatcherStarted = false;
function startSTOverlayWatcher() {
  if (stOverlayWatcherStarted) return;
  stOverlayWatcherStarted = true;
  // Polling instead of a MutationObserver here on purpose: ST's
  // drawers/popups open via a class toggle or a display-style change
  // on an element that may already exist in the DOM, which a
  // childList-based observer (like watchToggleButton's) won't catch.
  // A cheap interval sidesteps having to guess the exact attribute/
  // subtree config that would reliably catch every case.
  setInterval(updateSTOverlayYield, 250);
  updateSTOverlayYield();
}

// ---------------------------------------------------------------
// Toggle button - ground-up rewrite. The previous version built the
// button by hand out of huge inline cssText strings and only ever
// *logged* whether it ended up visible, which meant a real conflict
// left the user with no button and no on-screen sign anything was
// wrong. This version:
//   - defines its look in one real stylesheet (injected once, high-
//     specificity selectors) instead of a giant inline cssText blob
//   - uses a native <button> (proper focus/keyboard/AT support - a
//     styled <div> gets none of that for free)
//   - mounts on <html> rather than <body>, matching how the panel
//     itself is mounted (see forceFixedStyle/injectPanel), so both
//     float outside whatever container a theme might transform
//   - is watched by a MutationObserver instead of blind polling, so
//     it's put back within a frame if it's ever removed, with a
//     slower interval only as a backstop
//   - actively repairs what it finds wrong (see
//     checkAndRepairToggleHealth above) instead of only reporting it,
//     and puts up a visible banner if repair can't fix things
// ---------------------------------------------------------------

// On narrow screens ST's own compose bar and the virtual keyboard sit
// at the bottom of the screen, so the resting spot needs to be higher
// up there than on desktop.
function computeDefaultTogglePosition() {
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  return isMobile
    ? { bottom: "calc(100px + env(safe-area-inset-bottom, 0px))", right: "calc(10px + env(safe-area-inset-right, 0px))" }
    : { bottom: "calc(24px + env(safe-area-inset-bottom, 0px))", right: "calc(16px + env(safe-area-inset-right, 0px))" };
}

const TOGGLE_STYLE_ID = "phoneui-toggle-style";

// One real stylesheet, injected once, instead of repeating a giant
// inline cssText string every time the button gets (re)built. Every
// rule still carries !important + a specific selector so a host-page
// rule targeting the same class name can't quietly win.
function ensureToggleStylesInjected() {
  if (document.getElementById(TOGGLE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOGGLE_STYLE_ID;
  style.textContent = `
    #phoneui-togglewrap {
      all: initial !important;
      position: fixed !important;
      z-index: 2147483000 !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      display: block !important;
    }
    /* Bug fix: the ID selector above always beat the plain-class
       ".phoneui-hidden" rule in style.css (display:none !important) on
       specificity, even though both used !important - an ID always
       outranks a class regardless of !important or source order. That
       meant unchecking "Enable phone panel" in the settings drawer
       could never actually hide the floating button; it just silently
       stayed on screen. Pairing the ID with the class here matches
       (and beats) that specificity so the hidden state actually wins
       when it's supposed to. */
    #phoneui-togglewrap.phoneui-hidden {
      display: none !important;
    }
    #phoneui-togglewrap .phoneui-togglebtn {
      all: initial !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 52px !important;
      height: 52px !important;
      border-radius: 50% !important;
      border: none !important;
      background: #222 !important;
      color: #fff !important;
      cursor: grab !important;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35) !important;
      position: relative !important;
      user-select: none !important;
      touch-action: none !important;
      box-sizing: border-box !important;
      font: inherit !important;
      padding: 0 !important;
    }
    #phoneui-togglewrap .phoneui-togglebtn:focus-visible {
      outline: 2px solid #7ab8ff !important;
      outline-offset: 2px !important;
    }
    #phoneui-togglewrap .phoneui-toggle-badge {
      all: initial !important;
      position: absolute !important;
      top: -4px !important;
      right: -4px !important;
      background: #e0393e !important;
      color: #fff !important;
      font-size: 11px !important;
      font-family: sans-serif !important;
      min-width: 18px !important;
      height: 18px !important;
      line-height: 18px !important;
      text-align: center !important;
      border-radius: 9px !important;
      padding: 0 4px !important;
      box-sizing: border-box !important;
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function buildPhoneToggleElement() {
  const wrapper = document.createElement("div");
  wrapper.id = "phoneui-togglewrap";
  const pos = computeDefaultTogglePosition();
  wrapper.style.setProperty("bottom", pos.bottom, "important");
  wrapper.style.setProperty("right", pos.right, "important");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "phoneui-togglebtn";
  btn.className = "phoneui-togglebtn";
  btn.title = "Open phone (drag to move)";
  btn.setAttribute("aria-label", "Open phone");
  btn.innerHTML = PHONE_SVG;

  const badge = document.createElement("span");
  badge.id = "phoneui-badge";
  badge.className = "phoneui-toggle-badge";
  badge.textContent = "0";
  badge.setAttribute("aria-hidden", "true");

  btn.appendChild(badge);
  wrapper.appendChild(btn);
  return wrapper;
}

let toggleGuardianStarted = false;

function mountPhoneToggleButton() {
  ensureToggleStylesInjected();

  // Drop any stale copy first (a previous failed attempt, or a
  // guardian re-mount) so two buttons can never stack on each other.
  document.querySelectorAll("#phoneui-togglewrap").forEach((el) => el.remove());

  const wrapper = buildPhoneToggleElement();
  // Mounted on <html>, not <body> - keeps it out of whatever
  // container a theme applies a transform/overflow rule to, the same
  // reasoning forceFixedStyle already uses for the panel itself.
  (document.documentElement || document.body).appendChild(wrapper);
  forceFixedStyle(wrapper);

  const btn = wrapper.querySelector(".phoneui-togglebtn");
  // Wire up interactivity BEFORE anything that touches getSettings()
  // (applyTogglePosition, updateToggleBadge). Both of those can throw
  // if settings/metadata are in a broken state on a given SillyTavern
  // build - that shouldn't be able to leave the button visible but
  // dead (no click/drag), which is worse than just falling back to
  // the default corner position and an empty badge.
  btn.addEventListener("click", togglePanel);
  // Native <button> already fires "click" on Enter/Space, so no extra
  // keydown handling is needed for keyboard activation.
  attachToggleDragHandlers(wrapper, btn);

  try {
    applyTogglePosition(wrapper);
  } catch (e) {
    console.warn("[PhoneUI] Couldn't apply saved button position, using default corner.", e);
  }
  try {
    updateToggleBadge();
  } catch (e) {
    console.warn("[PhoneUI] Couldn't update the unread badge.", e);
  }

  startToggleGuardian();
  startSTOverlayWatcher();
}

// Keeps the button alive and correctly placed for as long as the
// extension is running. A MutationObserver on <html> catches removal
// almost immediately (a theme wiping/rebuilding part of the page); a
// slow interval underneath it is a backstop for whatever a childList
// observer might not catch (a style-only change that leaves the node
// in place but visually broken), not the primary mechanism.
function startToggleGuardian() {
  if (toggleGuardianStarted) return;
  toggleGuardianStarted = true;

  const root = document.documentElement || document.body;
  const observer = new MutationObserver(() => {
    if (!document.getElementById("phoneui-togglewrap")) {
      mountPhoneToggleButton();
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  setInterval(() => {
    const healthy = checkAndRepairToggleHealth();
    if (!healthy && !toggleHealthBannerShown) {
      toggleHealthBannerShown = true;
      showLoadError("The floating phone button couldn't be shown. Use the \"Open Phone\" button in Extensions > Phone UI, or type /phone in the chat box.");
    }
  }, 3000);
}

function injectPanel() {
  const div = document.createElement("div");
  div.innerHTML = panelSkeleton();
  const panelEl = div.firstElementChild;
  forceFixedStyle(panelEl);
  (document.documentElement || document.body).appendChild(panelEl);
  const statusBar = panelEl.querySelector("#phoneui-statusbar");
  if (statusBar) makePanelDraggable(panelEl, statusBar);
  panelEl.querySelector("#phoneui-homebtn")?.addEventListener("click", goHome);
  renderPanel();
}

// Shows/hides the floating button + panel to match the "enabled"
// setting, without needing a page reload.
//
// Bug fix: this used to hide things purely via the .phoneui-hidden
// class (display:none !important). That loses to the toggle button's
// own injected stylesheet rule (#phoneui-togglewrap { ... display:
// block !important }) - an ID selector always outranks a class
// selector at equal !important weight, class-toggling alone can
// never actually hide the wrapper. Setting display inline (with
// !important) sidesteps the specificity fight entirely: an inline
// style always wins over any selector-based rule from a stylesheet,
// even an !important one, so this is a hard guarantee either way.
function applyEnabledState() {
  const s = getSettings();
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  if (wrapper) {
    wrapper.classList.toggle("phoneui-hidden", !s.enabled);
    if (!s.enabled) wrapper.style.setProperty("display", "none", "important");
    else wrapper.style.removeProperty("display");
  }
  if (panel) {
    if (!s.enabled) {
      panel.classList.add("phoneui-hidden");
      panel.style.setProperty("display", "none", "important");
    } else {
      // Only clear the forced-hidden override here; whether the panel
      // is open or closed right now is togglePanel()'s job via the
      // .phoneui-hidden class, untouched by re-enabling.
      panel.style.removeProperty("display");
    }
  }
}

// Builds the settings block SillyTavern expects under Extensions ->
// this shows up as its own collapsible drawer there.
//
// This used to be a single synchronous attempt: if
// #extensions_settings2 / #extensions_settings wasn't in the DOM yet
// at the exact moment this ran, it just logged a console.error and
// gave up for good - no retry, and (unlike every other init failure
// in this file) no on-screen banner either, so the drawer would
// silently never appear with no clue why. It also never reacted to
// the container being rebuilt/cleared later, unlike the floating
// toggle button which has its own MutationObserver watcher for
// exactly that case.
//
// Now this retries (same 15s/60-attempt pattern as resolveContext)
// until the container shows up, and a watcher puts the drawer back
// if it's ever removed from the DOM after the fact.
let settingsDrawerWatcherStarted = false;
async function injectSettingsPanel() {
  let container = null;
  for (let i = 0; i < 60; i++) {
    container =
      document.querySelector("#extensions_settings2") ||
      document.querySelector("#extensions_settings");
    if (container) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!container) {
    console.error("[PhoneUI] Could not find #extensions_settings2 / #extensions_settings to mount into.");
    showLoadError(
      "Could not find the Extensions settings panel to add the Phone UI drawer to. Open the browser console for details."
    );
    return;
  }

  doInjectSettingsPanel(container);

  if (!settingsDrawerWatcherStarted) {
    settingsDrawerWatcherStarted = true;
    watchSettingsDrawer();
  }
}

// If the extensions panel ever gets rebuilt/cleared and takes our
// drawer with it, put it back instead of leaving it gone for good.
// Mirrors startToggleGuardian() above.
function watchSettingsDrawer() {
  const observer = new MutationObserver(() => {
    if (document.querySelector("#phoneui-settings-drawer")) return;
    const container =
      document.querySelector("#extensions_settings2") ||
      document.querySelector("#extensions_settings");
    if (container) doInjectSettingsPanel(container);
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

function doInjectSettingsPanel(container) {
  if (document.querySelector("#phoneui-settings-drawer")) return; // already injected

  const s = getSettings();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="phoneui-settings-drawer" class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Phone UI - Texts &amp; Social</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="phoneui-settings-row">
          <button id="phoneui-openbtn" class="menu_button" type="button">
            <i class="fa-solid fa-mobile-screen-button"></i> Open Phone
          </button>
        </div>
        <div class="phoneui-settings-hint">
          Use this (or type <code>/phone</code> in the chat box) any time the
          floating button isn't showing up for some reason - both open the
          same panel.
        </div>
        <label class="checkbox_label" for="phoneui-enabled-toggle">
          <input id="phoneui-enabled-toggle" type="checkbox" ${s.enabled ? "checked" : ""} />
          <span>Enable phone panel</span>
        </label>
        <label class="checkbox_label" for="phoneui-teachtags-toggle">
          <input id="phoneui-teachtags-toggle" type="checkbox" ${s.teachTagsEnabled ? "checked" : ""} />
          <span>Teach characters to use the phone automatically</span>
        </label>
        <div class="phoneui-settings-hint">
          When on, every prompt quietly includes the [TEXT:]/[NUMBER:]/
          [POST:] tag syntax, so characters can text you, hand out a
          number, or post on their own without you pasting instructions
          into each character's Author's Note yourself. Turn this off if
          you'd rather teach specific characters manually (see README).
        </div>
        <label class="checkbox_label" for="phoneui-autopost-toggle">
          <input id="phoneui-autopost-toggle" type="checkbox" ${s.autoPostsEnabled ? "checked" : ""} />
          <span>Let characters post to the feed on their own</span>
        </label>
        <div class="phoneui-settings-hint">
          When on, contacts you've already met occasionally post to
          the feed spontaneously, even if you haven't been chatting
          with them - not just via a [POST:] tag in a reply.
        </div>
        <label class="phoneui-settings-label" for="phoneui-autopost-frequency">How often</label>
        <select id="phoneui-autopost-frequency" class="text_pole" ${s.autoPostsEnabled ? "" : "disabled"}>
          <option value="rare" ${s.autoPostFrequency === "rare" ? "selected" : ""}>Rare (~every 20 min)</option>
          <option value="normal" ${s.autoPostFrequency === "normal" ? "selected" : ""}>Normal (~every 8 min)</option>
          <option value="often" ${s.autoPostFrequency === "often" ? "selected" : ""}>Often (~every 4 min)</option>
        </select>
        <label class="checkbox_label" for="phoneui-randomfeed-toggle">
          <input id="phoneui-randomfeed-toggle" type="checkbox" ${s.randomFeedEnabled ? "checked" : ""} />
          <span>Fill the feed with random posts</span>
        </label>
        <div class="phoneui-settings-hint">
          Backfills a fresh chat's Feed with posts (likes and comments
          included) from a recurring cast of ~3,000 made-up background
          profiles, so it never opens empty - purely synthetic flavor,
          not tied to any character.
        </div>
        <label class="checkbox_label" for="phoneui-randomactivity-toggle">
          <input id="phoneui-randomactivity-toggle" type="checkbox" ${s.randomActivityEnabled ? "checked" : ""} />
          <span>Let random profiles keep posting/liking/commenting/following on their own</span>
        </label>
        <div class="phoneui-settings-hint">
          Posts, likes, and follows are drawn from the theme's canned
          templates so this stays instant. Comments are the exception:
          each one asks the LLM to actually react to that specific
          post in character, falling back to a templated line only if
          that generation isn't available or fails.
        </div>
        <label class="phoneui-settings-label" for="phoneui-randomactivity-frequency">How often</label>
        <select id="phoneui-randomactivity-frequency" class="text_pole" ${s.randomActivityEnabled ? "" : "disabled"}>
          <option value="rare" ${s.randomActivityFrequency === "rare" ? "selected" : ""}>Rare</option>
          <option value="normal" ${s.randomActivityFrequency === "normal" ? "selected" : ""}>Normal</option>
          <option value="often" ${s.randomActivityFrequency === "often" ? "selected" : ""}>Often</option>
        </select>
        <label class="phoneui-settings-label" for="phoneui-randomcast-theme">Background cast theme</label>
        <select id="phoneui-randomcast-theme" class="text_pole">
          <option value="auto" ${s.randomCastThemeOverride === "auto" ? "selected" : ""}>Auto-detect from character/scenario</option>
          <option value="contemporary" ${s.randomCastThemeOverride === "contemporary" ? "selected" : ""}>Contemporary / modern-day</option>
          <option value="fantasy" ${s.randomCastThemeOverride === "fantasy" ? "selected" : ""}>Fantasy</option>
          <option value="scifi" ${s.randomCastThemeOverride === "scifi" ? "selected" : ""}>Sci-fi / space</option>
          <option value="historical" ${s.randomCastThemeOverride === "historical" ? "selected" : ""}>Historical / period</option>
        </select>
        <div class="phoneui-settings-hint" id="phoneui-randomcast-theme-hint">
          Controls the names and post flavor of the ~3,000 background
          profiles above. Auto-detect guesses from the active
          character card and recent chat text; this chat's cast is
          currently themed as <b>${escapeHtml(resolveCastTheme(s))}</b>.
          Changing this only affects new chats (or this one after you
          hit "Regenerate cast" below) - it won't retheme extras
          already baked into an existing feed.
        </div>
        <div class="phoneui-settings-row">
          <button id="phoneui-morerandom-btn" class="menu_button" type="button">
            <i class="fa-solid fa-shuffle"></i> Add more random posts
          </button>
        </div>
        <div class="phoneui-settings-row">
          <button id="phoneui-regencast-btn" class="menu_button" type="button">
            <i class="fa-solid fa-rotate"></i> Regenerate this chat's background cast
          </button>
        </div>
        <div class="phoneui-settings-hint">
          Wipes this chat's ~3,000 background profiles (and any posts/
          likes/comments/follows only they made) and rebuilds them
          using the theme above. Anything you actually did, or any
          real character said, is untouched.
        </div>
        <div class="phoneui-settings-row">
          <button id="phoneui-open-btn" class="menu_button" type="button">
            <i class="fa-solid fa-mobile-screen-button"></i> Open Phone UI
          </button>
        </div>
        <div class="phoneui-settings-hint">
          If the floating phone button doesn't appear on your device, use this
          button (or type <code>/phone</code> in the chat box) to open the panel
          instead. Same panel either way.
        </div>
        <div class="phoneui-settings-hint">
          Adds a floating phone button for texts, a social feed, Discord-style
          servers, and a follows/notifications system, driven by [TEXT:], [POST:],
          [DISCORD_INVITE:], [DISCORD:], [FOLLOW:], [LIKE:] and [COMMENT:] tags
          in character output. See the extension's README for the tag format.
        </div>
        <label class="phoneui-settings-label" for="phoneui-gifkey-input">
          Klipy API key <span style="opacity:0.7">(optional)</span>
        </label>
        <input
          id="phoneui-gifkey-input"
          type="text"
          class="text_pole"
          placeholder="Paste your free Klipy test key here (optional)"
          value="${escapeHtml(s.gifApiKey || "")}"
        />
        <div class="phoneui-settings-hint">
          The GIF/meme button on Texts, Discord, and Post works out of the
          box with a small built-in offline reaction library (emoji-style
          "gifs", no internet needed). Paste a free Klipy key here (from
          the Klipy Partner Panel at klipy.com) to also pull in real gifs
          from Klipy whenever you're online — the offline set is still used
          automatically if Klipy is unreachable, times out, or you're
          offline.
        </div>
        <label class="phoneui-settings-label">Your photo (persona)</label>
        <div class="phoneui-personaphoto-row">
          <div class="phoneui-avatar phoneui-avatar-sm">
            <img id="phoneui-personaphoto-preview" class="phoneui-avatarimg" src="${escapeHtml(s.personaPhoto || "")}" alt="" style="${
    s.personaPhoto ? "" : "display:none"
  }" />
          </div>
          <button id="phoneui-personaphoto-btn" class="menu_button" type="button">
            <i class="fa-solid fa-camera"></i> ${s.personaPhoto ? "Change photo" : "Set photo"}
          </button>
          <button
            id="phoneui-personaphoto-remove"
            class="menu_button ${s.personaPhoto ? "" : "phoneui-hidden"}"
            type="button"
          >
            <i class="fa-solid fa-trash"></i> Remove
          </button>
        </div>
        <div class="phoneui-settings-hint">
          Shows up as your avatar anywhere you post or message as
          yourself (Discord messages, feed posts) instead of your
          initials. Local to this install, same as the Klipy key above.
        </div>
        <div class="phoneui-settings-row">
          <button id="phoneui-reset-btn" class="menu_button">
            <i class="fa-solid fa-trash"></i> Clear all phone data
          </button>
        </div>
      </div>
    </div>`;
  container.appendChild(wrapper.firstElementChild);

  document.querySelector("#phoneui-openbtn").addEventListener("click", () => {
    openPhonePanel();
  });

  document.querySelector("#phoneui-enabled-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.enabled = e.target.checked;
    saveSettings();
    applyEnabledState();
  });

  document.querySelector("#phoneui-teachtags-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.teachTagsEnabled = e.target.checked;
    saveSettings();
  });

  document.querySelector("#phoneui-autopost-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.autoPostsEnabled = e.target.checked;
    saveSettings();
    const freqSelect = document.querySelector("#phoneui-autopost-frequency");
    if (freqSelect) freqSelect.disabled = !e.target.checked;
  });

  document.querySelector("#phoneui-autopost-frequency").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.autoPostFrequency = e.target.value;
    saveSettings();
  });

  document.querySelector("#phoneui-randomfeed-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.randomFeedEnabled = e.target.checked;
    saveSettings();
    if (e.target.checked) seedRandomFeed(); // in case this chat's feed was never seeded (was off at chat start)
  });

  document.querySelector("#phoneui-randomactivity-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.randomActivityEnabled = e.target.checked;
    saveSettings();
    const freqSelect = document.querySelector("#phoneui-randomactivity-frequency");
    if (freqSelect) freqSelect.disabled = !e.target.checked;
  });

  document.querySelector("#phoneui-randomactivity-frequency").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.randomActivityFrequency = e.target.value;
    saveSettings();
  });

  document.querySelector("#phoneui-morerandom-btn").addEventListener("click", () => {
    seedRandomFeed(true);
    renderPanel();
  });

  document.querySelector("#phoneui-randomcast-theme").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.randomCastThemeOverride = e.target.value;
    saveSettings();
    // Doesn't retheme an already-seeded cast by itself (see the hint
    // text) - just updates which theme "Regenerate cast" and any
    // future new chat will use.
  });

  document.querySelector("#phoneui-regencast-btn").addEventListener("click", () => {
    const btn = document.querySelector("#phoneui-regencast-btn");
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Regenerating...`;
    try {
      regenerateRandomCast();
      renderPanel();
      const hint = document.querySelector("#phoneui-randomcast-theme-hint");
      if (hint) {
        const theme = escapeHtml(resolveCastTheme(getSettings()));
        hint.innerHTML =
          `Controls the names and post flavor of the ~3,000 background ` +
          `profiles above. Auto-detect guesses from the active ` +
          `character card and recent chat text; this chat's cast is ` +
          `currently themed as <b>${theme}</b>. Changing this only ` +
          `affects new chats (or this one after you hit "Regenerate cast" ` +
          `below) - it won't retheme extras already baked into an existing feed.`;
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  // Opens the panel directly from the settings drawer, bypassing the
  // floating button entirely. Useful on devices/layouts where that
  // button doesn't render - this drawer is SillyTavern's own UI, so
  // if you can see this checkbox, this button works too.
  document.querySelector("#phoneui-open-btn").addEventListener("click", () => {
    const settings = getSettings();
    if (!settings.enabled) {
      settings.enabled = true;
      saveSettings();
      applyEnabledState();
      const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
      if (enabledToggle) enabledToggle.checked = true;
    }
    const panel = document.querySelector("#phoneui-panel");
    if (panel && panel.classList.contains("phoneui-hidden")) {
      togglePanel();
    } else if (!panel) {
      // Panel wasn't injected yet for some reason - inject then open.
      injectPanel();
      togglePanel();
    }
  });

  document.querySelector("#phoneui-gifkey-input").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.gifApiKey = e.target.value.trim();
    saveSettings();
  });

  document.querySelector("#phoneui-personaphoto-btn").addEventListener("click", async () => {
    const dataUrl = await pickImageFile();
    if (!dataUrl) return;
    const settings = getSettings();
    settings.personaPhoto = dataUrl;
    saveSettings();
    const preview = document.querySelector("#phoneui-personaphoto-preview");
    if (preview) {
      preview.src = dataUrl;
      preview.style.display = "";
    }
    document.querySelector("#phoneui-personaphoto-remove")?.classList.remove("phoneui-hidden");
    const btn = document.querySelector("#phoneui-personaphoto-btn");
    if (btn) btn.innerHTML = `<i class="fa-solid fa-camera"></i> Change photo`;
    renderPanel();
  });

  document.querySelector("#phoneui-personaphoto-remove").addEventListener("click", () => {
    const settings = getSettings();
    settings.personaPhoto = "";
    saveSettings();
    const preview = document.querySelector("#phoneui-personaphoto-preview");
    if (preview) {
      preview.src = "";
      preview.style.display = "none";
    }
    document.querySelector("#phoneui-personaphoto-remove")?.classList.add("phoneui-hidden");
    const btn = document.querySelector("#phoneui-personaphoto-btn");
    if (btn) btn.innerHTML = `<i class="fa-solid fa-camera"></i> Set photo`;
    renderPanel();
  });

  document.querySelector("#phoneui-reset-btn").addEventListener("click", () => {
    if (!confirm("Clear all texts, feed posts, contacts and Discord servers? This can't be undone.")) return;
    try {
      const settings = getSettings();
      settings.contacts = {};
      settings.threads = {};
      settings.groups = {};
      settings.groupThreads = {};
      settings.feed = [];
      settings.discordServers = {};
      settings.discordInvites = [];
      settings.storiesViewed = {};
      // Bug fix: this used to leave old notifications and GIF
      // rate-limit timestamps behind after a "clear all" - so the
      // Notifications tab kept showing entries (some pointing at
      // postIds that no longer existed) and a character's GIF
      // cooldown could still be in effect, even though everything
      // else had been wiped.
      settings.notifications = [];
      settings.lastGifSentAt = {};
      settings.randomCast = [];
      settings.randomFeedSeeded = false;
      settings.unread = 0;
      seedRandomFeed(); // give the freshly-wiped feed its initial random posts back, same as a brand new chat
      saveSettings();
      activeTab = "home";
      activeThread = null;
      activeGroup = null;
      activeServer = null;
      activeChannel = null;
      groupCreate = { open: false, name: "", selected: new Set() };
      gifPicker.open = false;
      stopStoryTimer();
      storyViewer = { open: false, author: null, index: 0, timerId: null };
      updateToggleBadge();
      renderPanel();
      // Belt-and-suspenders: re-assert the button/panel's core
      // visibility properties right after the re-render, in case
      // anything in the reset touched the DOM in a way a host-page
      // CSS rule could otherwise exploit to hide them.
      const wrapperEl = document.querySelector("#phoneui-togglewrap");
      const panelEl = document.querySelector("#phoneui-panel");
      if (wrapperEl) forceFixedStyle(wrapperEl);
      if (panelEl) forceFixedStyle(panelEl);
    } catch (e) {
      console.error("[PhoneUI] Clearing phone data failed unexpectedly.", e);
      showLoadError("Clearing phone data failed: " + e.message + ". Open the browser console for details.");
    }
  });

}

// Registers a /phone slash command that opens/closes the panel from
// the normal chat input - no floating UI involved at all, so it
// works even in whatever edge case is keeping the floating button
// from rendering (handy on mobile, where that button can be finicky
// to see). SillyTavern's slash command API has changed across
// versions - modern builds expose SlashCommandParser/SlashCommand
// either as bare globals or under `context`, older builds only have
// the deprecated registerSlashCommand (again either global or on
// `context`) - so this tries each known style in order and fails
// silently (console log only) if none match; this is a bonus
// convenience, not something init should ever abort over, and the
// settings-drawer "Open Phone UI" button still works regardless.
function registerPhoneSlashCommand() {
  const callback = () => {
    openPhonePanel();
    return "";
  };

  try {
    const parser = context.SlashCommandParser || (typeof SlashCommandParser !== "undefined" ? SlashCommandParser : null);
    const cmdClass = context.SlashCommand || (typeof SlashCommand !== "undefined" ? SlashCommand : null);
    if (parser && typeof parser.addCommandObject === "function" && cmdClass && typeof cmdClass.fromProps === "function") {
      parser.addCommandObject(
        cmdClass.fromProps({
          name: "phone",
          callback,
          helpString: "Opens (or closes) the Phone UI panel.",
        })
      );
      console.log("[PhoneUI] Registered /phone via SlashCommandParser.");
      return;
    }
  } catch (e) {
    console.warn("[PhoneUI] Modern slash command registration failed, trying legacy API.", e);
  }

  try {
    const reg = context.registerSlashCommand || (typeof registerSlashCommand !== "undefined" ? registerSlashCommand : null);
    if (typeof reg === "function") {
      reg("phone", callback, [], "- opens (or closes) the Phone UI panel", true, true);
      console.log("[PhoneUI] Registered /phone via registerSlashCommand.");
      return;
    }
  } catch (e) {
    console.warn("[PhoneUI] Legacy slash command registration failed too. /phone won't be available.", e);
  }

  console.log("[PhoneUI] Could not register /phone slash command on this SillyTavern build - use the 'Open Phone UI' button in the extension's settings drawer instead.");
}

// Shared by the settings-drawer "Open Phone" button and the /phone
// slash command: forces the panel on regardless of current state
// (auto-enabling if the whole extension was toggled off), instead of
// just calling togglePanel() and doing nothing if things are already
// in a weird state.
function openPhonePanel() {
  const settings = getSettings();
  if (!settings.enabled) {
    settings.enabled = true;
    saveSettings();
    applyEnabledState();
    const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
    if (enabledToggle) enabledToggle.checked = true;
  }
  let panel = document.querySelector("#phoneui-panel");
  if (!panel) {
    injectPanel();
    panel = document.querySelector("#phoneui-panel");
  }
  if (panel.classList.contains("phoneui-hidden")) {
    togglePanel();
  } else {
    togglePanel(); // already open - toggle acts as a close, matching a normal button
  }
}

async function initPhoneUI() {
  try {
    context = await resolveContext();
    if (!context) {
      // resolveContext() already showed a banner and logged details.
      return;
    }

    // Mount the floating button FIRST, in its own try/catch, before
    // touching settings/metadata at all. Previously getSettings() ran
    // first and the whole init shared one try/catch - so any throw in
    // getSettings() (e.g. structuredClone missing on some older/
    // embedded WebViews - now mitigated via safeClone above, but this
    // guards against whatever else could go wrong there too, like an
    // unexpected context shape on a given ST build) meant
    // mountPhoneToggleButton() never ran at all and the button simply
    // never existed, with nothing but an easy-to-miss banner as a
    // clue. Now the button's existence doesn't depend on settings
    // having loaded successfully - it comes up regardless, using
    // hardcoded defaults if getSettings() itself is broken.
    try {
      mountPhoneToggleButton();
    } catch (e) {
      console.error("[PhoneUI] Floating button failed to mount.", e);
      showLoadError("Floating button failed to mount: " + e.message + ". Open the browser console for details.");
    }

    getSettings();
    // Not awaited on purpose: this now retries internally for up to
    // ~15s if ST's Extensions panel container isn't in the DOM yet
    // (see injectSettingsPanel above), and the rest of the UI - most
    // importantly the floating phone button - shouldn't be stuck
    // waiting behind that. It injects itself whenever it's ready.
    injectSettingsPanel();
    injectNotificationContainer();
    injectPanel();
    applyEnabledState();
    registerPhoneSlashCommand();
    startAutoPostTimer();
    startRandomActivityTimer();
    seedRandomFeed();
    refreshPhoneContextPrompt();
    refreshTagInstructionPrompt();

    // Hook into ST's message stream. MESSAGE_RECEIVED fires with the
    // chat array index; we read the actual message text back out.
    const { eventSource, event_types } = context;
    eventSource.on(event_types.MESSAGE_RECEIVED, (index) => {
      // Bug fix: this used to ignore the enabled toggle entirely, so
      // turning "Enable phone panel" off in settings still parsed
      // every incoming message, popped toast notifications, and kept
      // piling data into threads/feed in the background - the toggle
      // only hid the button/panel, it didn't actually turn anything
      // off. Now a disabled phone truly does nothing until re-enabled.
      if (!getSettings().enabled) return;
      const msg = context.chat[index];
      if (msg && !msg.is_user) {
        handleIncomingMessage(msg.mes);
        // Whatever was silently queued (see queueHiddenNote) was
        // already included in the prompt that produced this reply -
        // keeping it queued would just re-inject the same note into
        // every future prompt forever.
        clearHiddenNotes();
      }
    });

    // Phone data (texts, feed, Discord, contacts) now lives in the
    // current chat's metadata, so switching chats swaps in a
    // different chat's phone state entirely. Drop any open
    // thread/channel/picker (they belonged to the old chat) and
    // refresh everything to match what's actually loaded now.
    if (event_types.CHAT_CHANGED) {
      eventSource.on(event_types.CHAT_CHANGED, () => {
        activeTab = "home";
        activeThread = null;
        activeGroup = null;
        activeServer = null;
        activeChannel = null;
        groupCreate = { open: false, name: "", selected: new Set() };
        messageDrafts = { threads: {}, groups: {} };
        gifPicker.open = false;
        stopStoryTimer();
        storyViewer = { open: false, author: null, index: 0, timerId: null };
        clearTypingState(); // cancel any in-flight "typing..." deliveries from the old chat
        getSettings(); // ensures the new chat's metadata is backfilled
        seedRandomFeed(); // this chat's own feed - each chat gets seeded independently
        applyEnabledState();
        updateToggleBadge();
        renderPanel();
        // The new chat's own feed/threads need to replace whatever
        // the old chat's context summary said - saveSettings() (the
        // usual trigger for this) isn't called on a plain chat
        // switch, so this needs its own explicit refresh here.
        refreshPhoneContextPrompt();
        refreshTagInstructionPrompt();
        const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
        if (enabledToggle) enabledToggle.checked = getSettings().enabled;
      });
    }

    console.log("[PhoneUI] loaded");
  } catch (e) {
    console.error("[PhoneUI] Unexpected error during init.", e);
    showLoadError("Unexpected error during init: " + e.message + ". Open the browser console for details.");
  }
}

// Use jQuery if it's available (normal ST case), but don't silently
// no-op if it isn't - fall back to a plain DOM-ready listener so a
// jQuery timing/load issue can't be the reason nothing appears.
if (typeof jQuery !== "undefined") {
  jQuery(async () => initPhoneUI());
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPhoneUI);
} else {
  initPhoneUI();
}
