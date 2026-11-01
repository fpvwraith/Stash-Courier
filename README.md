# elmatadore courier

A delivery bot for 6b6t. It runs on your own computer with your own bot account. It lives at your stash. When one of the builder bots asks for obsidian or crying obsidian, it takes **full shulker boxes of it** from your chests, teleports to that builder, puts them in the chest next to it, and goes back home with `/kill`. It respawns at its bed by your stash.

## How it finds the obsidian

The first time you set it up at the stash, it walks the whole stash once and opens every chest and barrel within 32 blocks of its bed. It writes down which ones hold full boxes of obsidian and crying obsidian.

After that, each order goes straight to those chests. When the chests it knows about run out, it walks the stash again by itself and picks up anything you refilled. It also takes a fresh look every 6 hours while it's idle. You can make it look again any time by whispering `index`.

## What keeps your stash safe

- **The builders never come to you.** The courier always goes to them with `/tpa`. It never accepts a teleport request from anyone, so nobody can teleport to it at your stash.
- **It only answers the builders you list** in `config.json`, and only to an order like `3 boxes obsidian to my chest` or `3 boxes crying_obsidian to my chest`.
  - Anyone else who whispers it is logged and ignored.
  - A fake "whisper" typed in public chat doesn't count, because 6b6t puts `»` in public chat.
- **It only takes full shulker boxes that hold one item from `items`**, and nothing else.
  - Any other box (kits, diamonds, half-full boxes, mixed boxes) and any loose item is never touched.
  - Trapped chests are never opened.
- **It carries nothing else on a trip.**
  - Before it leaves, everything else it holds (food, tools, armour, the other item's boxes) goes into a chest at the stash.
  - A death or `/kill` at the build site therefore loses nothing of yours except what was already delivered.
- **There are caps:**
  - at most 10 boxes per order
  - at most 80 boxes an hour
  - at most 10 orders waiting

  The first two are set in `config.json`.
- **It talks to nothing but the Minecraft server.** No website, no Discord, no tracking.
  - Your Microsoft sign-in is kept in `data/auth/` on your computer.
  - The stash spot and the list of chests are kept in `data/`.
  - Keep the `data/` folder private.
- **It never says where it is in chat.** The log (`logs/courier.log`) stays on your computer.

## Setup (once)

1. **Install Node.js** 20 or newer from nodejs.org.
2. **Install the bot.** In this folder, run:
   ```
   npm ci
   ```
3. **Make your config.** Copy `config.example.json` to `config.json` and fill in:

   | Setting | What to put |
   |---|---|
   | `username` | The bot account's Microsoft e-mail |
   | `owner` | Your main account's name. Only this name can give it the setup commands below. |
   | `builders` | The builder bot names we send you |

4. **At the stash:**
   - Put a bed where the bot should live.
   - Keep the obsidian and crying obsidian boxes in chests or barrels within 32 blocks of the bed, somewhere it can walk to.
   - Leave a few free slots in some chest for the bot's own things.
5. **Start it.** Run:
   ```
   node courier.js
   ```
   The first time, it prints a Microsoft sign-in link and code. Open the link and enter the code with the bot account.
6. **Bring it to the stash.** On your main account, standing by the bed:
   - Whisper it `come`. It sends you a `/tpa`; accept it.
   - Whisper it `bed`. It clicks the bed, remembers the spot, walks the stash once to index it, and whispers you what it found.

From then on it serves the builders by itself.

## Owner whispers

Only from the `owner` name:

| Whisper | What it does |
|---|---|
| `status` | Tells you how many orders are waiting, boxes sent in the last hour and in total, any lost, the boxes it knows about, and whether it's paused |
| `pause` / `resume` | Stops or restarts taking trips (it stays online) |
| `come` | It sends you a `/tpa`, if it isn't on a trip |
| `bed` | Clicks the bed within 4 blocks, saves that spot as the stash, and indexes the stash |
| `index` | Walks the stash again and recounts the boxes |

## Files you can use

| File | What it does |
|---|---|
| `STOP` | Create this file (any content) and it logs off and the program ends |
| `PAUSE` | It takes no trips while this file exists. It also creates `PAUSE` itself if it can't get back to the stash after a trip. |

## When something goes wrong

- **Captcha.** If 6b6t sends a captcha, the log prints the verify link. The bot stays offline 8 minutes so you can solve it.
- **Other disconnects.** It reconnects by itself: after 30 s, and longer if it keeps failing quickly, up to 10 minutes.
  - If the connection drops in the middle of a trip, it finishes the hand-over when it's back, then goes home.
- **A builder is offline or doesn't accept.** It asks 3 times, then puts the boxes back in the stash.
- **Empty stash.** If there are no full boxes left, it whispers you (at most once an hour) and keeps looking every 5 minutes. Refill and it carries on by itself.
- **The bed is gone.** If it can't respawn at the stash, it pauses and whispers you. To fix it:
  1. Put the bed back.
  2. Whisper `come`, then `bed` beside the bed.
  3. Whisper `resume`.

## Check it

```
npm test
```

That runs the chat-reading tests. `test/suite.js` is the full test we ran on a private test server; you don't need it.
