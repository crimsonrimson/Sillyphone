# Phone UI - Texts & Social (SillyTavern extension)

A floating phone panel for SillyTavern: text NPCs individually, post to
a shared social feed, tag people with @, get invited into Discord
servers and chat in channels, and browse contacts — all layered on
top of your normal chat.

## Install

1. In SillyTavern, go to **Extensions -> Install extension**, and either:
   - paste the folder path if you're loading it locally, or
   - zip this folder and use "Load from file" (method depends on your
     ST version — check Extensions > Manage extensions for the exact
     import flow on yours).
2. Alternatively, drop this whole `silly-phone` folder into
   `SillyTavern/public/scripts/extensions/third-party/`, then restart
   ST and enable it from the Extensions panel.
3. A small phone icon button will appear floating in the bottom-right
   corner of the screen. Click it to open/close the panel.
   - Drag the **button** anywhere on screen; it remembers where you
     drop it, and the panel opens right next to wherever it is.
   - Drag the phone **panel itself** by its status bar (the "9:41" bar
     at the top) to put the open panel somewhere different from the
     button — once you do, that spot sticks even if you move the
     button afterward.

## Teach your character to use it

The extension only pulls a message into the phone UI if it's tagged.
Add something like this to the character's Author's Note, system
prompt, or a World Info entry:

```
When sending the user a text message, prefix that line with
[TEXT:YourCharacterName] followed by the message.
When posting to social media, prefix the line with
[POST:YourCharacterName] followed by the caption. Use #hashtags and
@mentions naturally in posts.
To follow the user on social media, use [FOLLOW:YourCharacterName].
To like the user's latest post, use [LIKE:YourCharacterName]. To
comment on it, use [COMMENT:YourCharacterName] followed by the
comment text.
```

Example model output that the extension will catch:

```
[TEXT:Aiden] hey, you up? something happened at the warehouse
[POST:Aiden] can't sleep. something's off tonight. #insomnia @Maya check your messages
[DISCORD_INVITE:Night Owls:Aiden] join our server, it's easier to talk here
[DISCORD:Night Owls>general:Aiden] ok everyone's finally online, let's talk
[GROUP_START:Night Owls Crew:Aiden,Maya] pulling you both into a group chat
[GROUPTEXT:Night Owls Crew:Aiden] ok we're all here now
[NUMBER:Aiden] (555) 019-2847
[GIF:Aiden] eye roll
[GROUPGIF:Night Owls Crew:Maya] laughing
[DISCORDGIF:Night Owls>general:Aiden] fire
[POSTGIF:Aiden] celebration | we did it
[TEXT_UNKNOWN:(555) 083-7719] who is this. you need to leave me alone
[REPOST:Maya:Aiden] not okay, everyone stay inside tonight
[FOLLOW:Aiden] just started following you
[LIKE:Maya] liked your last post
[COMMENT:Aiden] wait this is wild, are you okay??
```

Notes on `FOLLOW`/`LIKE`/`COMMENT`:
- These are "bare" tags (`LIKE`/`FOLLOW`) or a tag plus free text
  (`COMMENT`) — no colon-separated target needed. `LIKE` and
  `COMMENT` always act on the user's own most recent feed post; if
  the user hasn't posted anything yet, the tag is silently ignored
  (logged to console).
- Each one shows up as a real notification in the phone's
  Notifications tab, and also as an actual SillyTavern toastr popup
  (the same kind ST itself uses), not just an in-phone banner.
- `FOLLOW`/`LIKE`/`COMMENT` don't need to be things the model
  reaches for constantly — a character who occasionally likes or
  comments on the user's posts, or eventually follows back after the
  user follows them, reads a lot more natural than one who reacts to
  every single post.

Notes on `NUMBER`:
- Use it when a character would actually hand over their phone number
  in the scene ("here, put my number in your phone" etc.). It adds/
  updates that contact's number, which then shows in their thread
  header and in the Contacts tab (with a tap-to-copy icon) — that's
  the "add them to your contacts" part.
- The number after the tag has to actually look like a real, dialable
  phone number (10 digits, formatting-insensitive — `(555) 019-2847`,
  `555-019-2847`, `5550192847` all work) or the tag is silently
  ignored (logged to console) and no contact gets created/updated.
  This is what makes `NUMBER` mean something: a character can't hand
  over a garbled or placeholder "number" and have it stick.
- Always use a clearly fictional-looking number — a `555` exchange
  (e.g. `(555) 019-2847`) is the standard reserved-for-fiction range
  in North American formatting, so it never collides with a real
  person's number, and it passes the validity check fine. Tell your
  character/model to stick to that pattern rather than inventing an
  arbitrary real-looking one.
- It doesn't have to ride along with a `TEXT` in the same message —
  it can stand on its own the moment the number gets mentioned in
  normal narration/dialogue.
- A number is only ever "valid" for the one character who actually
  handed it out — if some other character's `NUMBER` tag shows up
  with a number already claimed by someone else, it's ignored.

Notes on adding contacts yourself (Contacts tab):
- You can only add a contact by phone number, not by typing a name —
  same as a real phone, there's nothing to text until you actually
  have a number for them. Entering something that isn't a
  real-looking number is rejected the same way an AI-offered `NUMBER`
  is.
- A number you add this way opens as an unnamed/"Unknown" thread,
  exactly like a stranger texting you first (see `TEXT_UNKNOWN`
  below) — if the model later reveals whose number it is with
  `[NUMBER:Name]`, that thread automatically folds into the named
  contact.
- Every contact — named or still unknown — has a nickname field (the
  pencil icon next to them, in the Contacts tab or a thread header).
  It's a purely local label for your own use; it doesn't rename the
  contact as far as the model's tags are concerned, so an NPC keeps
  addressing/being addressed by their real name no matter what
  nickname you've given them.

Notes on profile pictures:
- Every contact can have a profile picture — tap the camera icon next
  to them (Contacts tab or a thread header) to upload one from your
  device; a matching "remove photo" icon shows up in the thread
  header once one's set, to go back to the plain initials circle.
  Pictures are resized down to a small thumbnail client-side before
  they're saved, so this doesn't bloat chat storage even with a full-
  resolution photo.
- You can set your own photo too, from the extension's settings
  drawer ("Your photo (persona)") — it's install-wide, not per-chat,
  same as the Klipy key. It shows up anywhere you post or message as
  yourself: your own feed posts, Discord messages, and so on.
- Contact photos are purely visual, same idea as nicknames — they
  don't get sent to the model or affect tag routing in any way.

Notes on the group text tags:
- `GROUP_START` creates a group thread (or adds members to an
  existing one) - it's how the user first ends up in a multi-person
  thread, similar to a Discord invite except there's no accept step.
  `Member1,Member2,...` is a comma-separated list of everyone besides
  the user; any name not already a contact is added as one.
- `GROUPTEXT:GroupName:SenderName` posts a message into that group
  thread from that sender. Like Discord messages, a `GROUPTEXT`
  targeting a group the user hasn't been added to yet (via
  `GROUP_START`) is silently ignored.
- The user can also start a group themselves from the phone's Texts
  tab (tap the group icon in the header, pick 2+ contacts, name it).
  Their replies in a group thread go back to the model as
  `[GROUPTEXT:GroupName:UserName] message`, so the whole cast can see
  and react to them.

Notes on the Discord tags:
- `DISCORD_INVITE` shows up as an accept/decline card at the top of
  the Discord tab. Only after the user accepts does the server show
  up in their server list — an NPC can't post into a server the user
  hasn't joined yet, so `DISCORD` messages targeting a server the
  user hasn't accepted are silently ignored.
- `DISCORD:ServerName>ChannelName:CharacterName` posts into that
  channel; if the channel doesn't exist yet it's created
  automatically. Every server starts with a default `general` channel.

Notes on the GIF tags:
- These let an NPC send an actual GIF, not just talk about one — same
  search behind the picker you tap (offline library, plus Klipy if
  you've set a key and you're online), just auto-picking the top
  result for whatever search term the model gives instead of showing
  a grid. Since there's always an offline result to fall back to,
  this basically always succeeds now; the "couldn't be sent" text
  bubble is just a last-resort safety net for the rare case something
  throws unexpectedly, instead of failing silently.
- `[GIF:Name] search term` / `[GROUPGIF:GroupName:Name] search term` /
  `[DISCORDGIF:Server>Channel:Name] search term` all work like
  `TEXT`/`GROUPTEXT`/`DISCORD` — same typing delay, same "can't post
  somewhere the user hasn't joined yet" rule — except the text is a
  Klipy search query (e.g. `laughing`, `eye roll`, `fire`) rather than
  a caption, since this is a reaction, not a message.
- `[POSTGIF:Name] search term` posts a GIF to the feed. Add
  `| caption text` after the search term for an optional caption
  (`[POSTGIF:Aiden] fire | that escalated fast`); leave it off to
  post just the GIF.
- Each character is rate-limited to one GIF (of any kind — text,
  group, Discord, or post) per 60 seconds, so a model can't spam
  reaction GIFs back to back. Extra `GIF`/`GROUPGIF`/`DISCORDGIF`/
  `POSTGIF` tags from the same name within that window are silently
  ignored (logged to console) rather than queued up. The cooldown is
  the `GIF_COOLDOWN_MS` constant near the top of `index.js` if you
  want it shorter/longer.

Notes on `TEXT_UNKNOWN` (unresolved numbers):
- Use this instead of `TEXT` when someone texts the user who isn't a
  contact yet and hasn't been named — a stranger, a wrong number, a
  burner phone, etc. `[TEXT_UNKNOWN:PhoneNumber] message` opens a
  thread under that raw number (avatar shows `?`) instead of a name,
  same "typing…" delay and everything else a normal `TEXT` gets. Like
  `NUMBER`, the number has to actually look like a real one or the
  tag is ignored.
- It resolves automatically the moment a `[NUMBER:Name] PhoneNumber`
  tag shows up with a matching number (formatting-insensitive — digits
  are compared, not the exact string) — the thread's whole history
  migrates onto that named contact. The user can also resolve it
  themselves from the thread header with a "Save as contact" field,
  which sends `[SYSTEM] ... saved <number> as a contact named "..."`
  back to the model so it knows the user has figured out who it is.
- Good for mystery/stranger-danger beats: text as `TEXT_UNKNOWN` for
  as long as the identity should stay hidden, then reveal it with a
  `NUMBER` tag (or let the user out it themselves) whenever the scene
  calls for it.

Notes on `REPOST` (retweet/share):
- `[REPOST:ReposterName:OriginalAuthorName] optional added caption`
  reposts that author's most recent feed post under ReposterName's
  name, the caption is optional — leave it blank for a bare repost,
  or add a comment (`[REPOST:Maya:Aiden] this is not okay`). It's
  silently ignored if `OriginalAuthorName` has no post in the feed to
  repost.
- The feed shows a small "🔁 X reposted" label above the original
  author's content, with the reposter's own caption (if any)
  underneath — same idea as a retweet-with-comment. Reposting a
  repost points back at the original post, not the repost itself.
- The user can repost too, from the retweet icon next to like/comment
  on any post — it prompts for an optional caption and sends
  `[REPOST:UserName:AuthorName] caption` back to the model the same
  way an NPC's repost would look.

Notes on blocking a contact:
- The ban icon in a contact's thread header (or next to them in the
  Contacts tab) blocks them. This sends `[SYSTEM] ... has blocked
  <Name>. <Name> should not send any more texts, group messages,
  posts, or Discord messages until unblocked.` back to the model, and
  the extension backs that up itself: any `TEXT`, `GIF`, `GROUPTEXT`,
  `GROUPGIF`, `POST`, `POSTGIF`, `DISCORD`, `DISCORDGIF`, or
  `DISCORD_INVITE` tag from a blocked name is silently dropped
  (logged to console) even if the model sends one anyway, so a
  blocked character genuinely stops appearing rather than relying on
  the model remembering the system note. The blocked contact's thread
  shows a "You've blocked X" banner with an Unblock button in place of
  the message box. Tap the same ban icon (now red) to unblock, which
  sends a matching `[SYSTEM] ... has unblocked <Name>.` note.

Anything not tagged this way stays as normal narration in the main
chat window — you don't have to convert everything to texts.

## Follows, follower counts & notifications

- Every contact gets a follower count the first time they show up,
  generated once and then stable for the rest of the chat (it won't
  reroll on every reopen). Most contacts land in an ordinary
  hundreds-to-low-thousands range. If a character's own card reads as
  famous — words like "celebrity", "pop star", "renowned",
  "influencer", "household name", "grammy", "viral", etc. show up in
  their description/personality/tags — they instead get a
  celebrity-sized count (roughly 500K–12M) and a small verified badge
  next to their name in the Feed and Contacts tab. This is a plain
  keyword heuristic, not a real fame model — it's flavor for the
  social app, not a judgment about the character.
- A Follow/Following button sits next to every contact in the Feed
  (post header) and Contacts tab. Following someone sends a quiet
  note to the model (so it knows the relationship changed) and has a
  randomized chance of a delayed follow-back — much rarer for famous
  contacts, since a celebrity following back every fan wouldn't track.
- Tapping a contact's avatar or name — in the Feed post header,
  Contacts/Texts list, a thread header, or a Notifications entry —
  opens their **profile page**: avatar, name (with the verified badge
  if they're famous), a follower count, a short bio pulled from their
  character card's description (when one can be matched), a
  Follow/Message row, and a grid of every post they've made to the
  Feed. Tapping a name doesn't also open the thread — that's still a
  tap anywhere else on the row, same as before. Your own profile
  works the same way, minus the Follow/Message row; open it from the
  row at the top of the **Home** screen (your avatar + name), or by
  tapping your own avatar/name on any post you've made in the Feed.
- The **Notifications** tab (new home-screen icon, bell badge) is a
  running feed of things that happened *to the user*: someone
  followed them, liked their post, commented on it, mentioned them in
  a post, or reposted something of theirs. Tapping an entry marks it
  read and jumps to the relevant tab; opening the Notifications tab
  at all clears its badge, same instinct as a real phone.
- Every one of those events also fires an actual SillyTavern system
  notification (`toastr`, the same popup style ST itself uses),
  alongside the phone's own lock-screen-style banner — so it feels
  like a real notification, not just something buried in an app you
  have to remember to check.

## What's in the panel

- **Texts** — tap a contact to open the thread. Type and hit the send
  arrow (or Enter) to reply; this both adds your bubble locally and
  pushes the message into the main chat input so the model has full
  context for its next reply. Tap the GIF icon next to the input to
  react with a GIF/meme instead of (or alongside) typing. Group
  threads with multiple NPCs show up in the same list (with a square
  icon instead of a round one) — tap the people icon in the Texts
  header to start one yourself, or wait for a character to pull you
  into one. Inside a group thread, each NPC message is labeled with
  who sent it. A texted reply doesn't land instantly — the sender
  shows "typing…" with an animated dots bubble for a short beat
  (scaled to the message's length) first. Your most recent message
  shows "Delivered" until someone replies, then flips to "Seen"
  (1:1) or "Seen by ..." / "Seen by all" (groups) — this is derived
  from the thread itself (a reply implies a read), not a separate
  tracked state. A text from an unresolved number (see `TEXT_UNKNOWN`
  below) shows up in the list under the raw number with a `?` avatar
  until it's resolved to a name. The ban icon in a thread's header
  blocks/unblocks that contact.
- **Feed** — a scrolling social feed. Like posts, leave comments,
  repost (with an optional caption of your own), tap in from Compose.
  A Stories strip sits above the feed listing anyone who's posted in
  the last 24h (gray ring once you've seen their latest) — tap an
  avatar to play their recent posts full-screen with an auto-advancing
  progress bar, tap the sides to go back/forward, or reply from the
  box at the bottom of the story to send that character a DM (closes
  the story and opens the resulting thread).
- **Post** — write a new post. Typing `@` shows a quick-tag list of
  your known contacts; click one to insert it. `#hashtags` are
  auto-styled once posted. "Add GIF/meme" attaches a GIF from Klipy
  to the post (with or without caption text).
- **Discord** — pending invite cards up top; accepted servers show as
  a list, tap in to see channels, tap a channel to chat. Add a
  channel with the + row at the bottom of a server's channel list.
  The GIF icon in a channel works the same way as in Texts.
- **Contacts** — add people by phone number, or they'll be added
  automatically the first time they text you or post something. A
  `NUMBER` tag (see above) adds a tap-to-copy phone number under
  their name here too, and in their thread header. An unresolved
  `TEXT_UNKNOWN` number shows here as "Unknown" with its raw number
  underneath until it's named. The camera icon sets a profile
  picture, the pencil sets a nickname, and the ban icon blocks/mutes
  that contact without opening their thread.
- **Notifications** — while the phone panel is closed, any new
  tagged text, post, invite, or Discord message pops a banner in the
  top-right corner (auto-dismisses after ~7s, stacks up to 4). Click
  a banner to jump straight into that conversation/channel/feed;
  click the × to dismiss without opening. The unread badge on the
  phone icon also keeps counting even after banners clear.

## GIFs & memes

The GIF icon (Texts, Discord, and Post) opens a picker: a search box
up top, quick-tap "reaction" shortcuts (😂 😭 😍 😱 😡 🔥 💀 👍 etc.)
for common chat reactions, and a scrolling grid of results below.
Tapping a result in Texts/Discord sends it immediately as a reaction;
in Post it attaches to your draft so you can still add a caption
before posting. The model sees a short `[sent a GIF reaction:
"title"]` note alongside any caption so it can react to what was sent
even though it can't see the image itself.

**Works offline, no setup required.** GIFs/memes are backed by a
small built-in reaction library — animated emoji-on-a-card "gifs"
generated entirely client-side, nothing downloaded or fetched — so
searching, trending, quick-tap reactions, and the `GIF`/`GROUPGIF`/
`DISCORDGIF`/`POSTGIF` tags all work immediately with zero setup and
zero internet access. Search matches your query against each
reaction's tags (e.g. "laughing", "fire", "eye roll"); an empty
search or an unmatched query returns a shuffled grid from the whole
set rather than coming up empty.

If you want real gifs on top of the offline set, paste a free Klipy
API key into the extension's settings drawer (Extensions -> Phone UI
- Texts & Social -> Klipy API key) — grab one (up to 100 req/hour)
from the Klipy Partner Panel at klipy.com. Unlike Giphy, Klipy doesn't
publish a shared public demo key, so this step is optional and purely
additive: with a key and a connection, search/trending pull from
Klipy first; without a key, offline, or if a Klipy request fails or
times out (~6s), it falls back to the offline library automatically —
the GIF/meme feature never just stops working.

## Random feed content

The Feed doesn't have to start empty and silent. Two settings (both on
by default, in the extension's settings drawer) control a recurring
cast of ~3,000 made-up background profiles - not tied to any character
card:

- **Fill the feed with random posts** - the first time a chat opens
  its Feed, it gets backfilled with ~70-110 posts (with likes and a
  handful of comments already on them, spread over the last ~9 days)
  from a recurring cast of ~3,000 background profiles, so it reads like
  a real, lived-in feed instead of "No posts yet." Runs once per chat,
  entirely offline for speed. Use the **Add more random posts** button
  in settings any time you want another batch layered on top.
- **Let random profiles keep posting/liking/commenting/following on
  their own** - on a timer (frequency: Rare/Normal/Often, same idea as
  auto-posts above), a random cast member posts something new, likes
  or comments on an existing post (including yours - it shows up as a
  real Notification, same as a `[LIKE:]`/`[COMMENT:]` tag would), or
  follows you. Posts/likes/follows use the theme's canned templates so
  this stays fast; comments are the one piece that's actually
  generated - each one asks the LLM to react to that specific post in
  character, falling back to a templated line only if generation isn't
  available or fails.

**Background cast theme.** The cast's names and post flavor adapt to
the story instead of always being modern-day. A **Background cast
theme** dropdown in settings (Auto-detect / Contemporary / Fantasy /
Sci-fi / Historical) controls this - auto-detect reads the active
character card and recent chat text for genre keywords and picks the
closest match, defaulting to contemporary if nothing stands out. The
theme is locked in the first time a chat's cast is generated, so it
won't drift mid-story; use the **Regenerate this chat's background
cast** button after changing the dropdown (or if auto-detect guessed
wrong) to wipe this chat's extras and rebuild them under the new theme
- posts/likes/comments from real characters or you are untouched.

These background profiles stay out of the Texts and Contacts tabs
(they're feed flavor, not people to message) unless you actually
follow one or message them first - at that point they behave like any
other contact. Turning either setting off stops it going forward, but
doesn't remove posts already added; use "Clear all phone data" (or
just don't re-add more) if you'd rather not have them at all.

## Known limitations / things to tune

- This uses ST's standard `#send_textarea` / `#send_but` selectors to
  push messages through — if a future ST UI update renames those
  elements, sending will need a one-line selector fix in `index.js`.
- Phone content (threads, feed, contacts, Discord servers) is scoped
  per chat, stored in that chat's metadata — switching chats swaps in
  that chat's own phone state. The "Enable phone panel" toggle, the
  dragged button position, and the Klipy API key are install-wide
  instead, so they stay put across chats. If your SillyTavern build
  doesn't expose chat metadata for some reason, phone content falls
  back to the old global behavior automatically (with a console
  warning) rather than breaking.
- Likes/comment counts on NPC posts are seeded with a small random
  number just for flavor — remove that line in `index.js` if you'd
  rather everything start at zero.
- GIF/meme reactions work fully offline (see "GIFs & memes" above).
  Klipy is only used opportunistically when a key is set and the
  request succeeds within a few seconds; the built-in offline library
  (`LOCAL_GIF_LIBRARY` in `index.js`) is the fallback and covers
  everyday reactions (laughing, crying, fire, angry, thumbs up,
  celebration, etc.) — edit that array to add or restyle entries.

## Ideas for extending further

- Pinned/highlighted stories that don't expire after 24h
- Muting a thread's notifications without fully blocking the contact
- Editing/deleting a sent post or text
