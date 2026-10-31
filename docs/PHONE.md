# Using P.O.A on your phone

P.O.A runs on your computer. Your phone connects to it in two ways:

1. **Reminders and nudges** arrive as phone notifications through the free **ntfy** app, with **Done** and **Snooze 1h** buttons.
2. **The full app** opens on your phone like a normal app, from your home screen, wherever you are.

Setup takes about 15 minutes. Do part 1 first: it's the most useful part, and it works even if you skip part 2.

> **One thing to know:** reminders are sent by your computer, so P.O.A must be running (`npm start`) and the computer awake. If it was off, missed reminders arrive as soon as it starts again, marked as missed. To make this easy, set P.O.A to start when you log in (see the end of this guide).

---

## Part 1: Notifications on your phone (5 minutes)

1. Install **ntfy** on your phone: [Android (Google Play)](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or [iPhone (App Store)](https://apps.apple.com/app/ntfy/id1625396347).
2. Make up a **topic name** that nobody could guess, for example `saint-poa-7f3k9q2m`. On the public ntfy server, anyone who knows a topic name can read it, so treat it like a password.
3. In the ntfy app, tap **+** (Subscribe to topic) and enter that name.
4. On your computer, add it to P.O.A's `.env` file:
   ```
   POA_NTFY_TOPIC=saint-poa-7f3k9q2m
   ```
5. Restart P.O.A (`Ctrl+C`, then `npm start`). Go to **About me → Phone → Send a test notification**. It should appear on your phone within seconds.

**Privacy note:** reminder titles pass through ntfy.sh on their way to your phone. Keep very private things as items without reminders, or [run your own ntfy server](https://docs.ntfy.sh/install/) and set `POA_NTFY_SERVER` to it.

---

## Part 2: Open P.O.A on your phone, from anywhere (10 minutes)

The safest way is **Tailscale**. It's free and creates a private network between only your own devices. Nothing is opened to the internet.

1. Install Tailscale on your computer from [tailscale.com/download](https://tailscale.com/download) and sign in.
2. Install the Tailscale app on your phone and sign in with the **same account**. Turn it on.
3. On your computer, open a terminal and run:
   ```
   tailscale serve --bg 3000
   ```
   It prints an address like `https://your-computer.tail1234.ts.net`. That's your private P.O.A link. It works only on your devices, and it uses HTTPS.
4. Add these lines to `.env`, using your own address and a passcode you choose:
   ```
   POA_PUBLIC_URL=https://your-computer.tail1234.ts.net
   POA_PASSCODE=pick-something-long
   ```
   - The passcode is an extra lock.
   - The public URL makes the notification's **Done** and **Snooze** buttons work, and opens P.O.A when you tap a notification.
5. Restart P.O.A. On your phone, open the address. Enter any username and your passcode when asked.
6. Add it to your home screen so it opens like an app:
   - **iPhone (Safari):** tap Share, then **Add to Home Screen**.
   - **Android (Chrome):** tap the menu (⋮), then **Install app** or **Add to Home screen**.

### Simpler option: same Wi-Fi only

If you only want to use P.O.A at home, you can skip Tailscale:

1. Add these lines to `.env`:
   ```
   POA_HOST=0.0.0.0
   POA_PASSCODE=pick-something-long
   ```
   P.O.A refuses to start this way without a passcode, so nobody else on your Wi-Fi can open it.
2. Find your computer's local address:
   - **Windows:** run `ipconfig` and look for the IPv4 address, like `192.168.1.20`.
   - **Mac:** go to System Settings → Wi-Fi → Details.
3. On your phone, open `http://192.168.1.20:3000`, using your own address.

Two limits: it only works on the same Wi-Fi, and Android may not offer "Install app" without HTTPS. A home-screen shortcut still works.

---

## Using it day to day

- **Set a reminder:** open any item, then set **Remind me at** and optionally **Repeat** (every day, weekdays, every week, every month). Or just tell P.O.A, for example "remind me to call mum Sunday at 5", and accept its suggestion.
- **Daily nudges:** at the times you choose in **About me → Reminders and nudges**, you get:
  - a morning check-in that includes what's due
  - an evening review
  - a weekly review on the day you choose

  A nudge that would arrive more than two hours late is skipped, so you don't get a "good morning" at 3 pm.
- **From the notification:**
  - **Done** marks the item done. For a repeating reminder, it records this time only.
  - **Snooze 1h** moves the reminder by an hour.
  - Tapping the notification itself opens P.O.A.
- **In the app:** new reminders show at the top of **Today** with the same buttons. While P.O.A is open in a browser, tap **Allow notifications in this browser** to get pop-ups there too.

## Start P.O.A automatically (Windows)

So reminders keep coming without you starting P.O.A by hand:

1. Press `Win + R`, type `shell:startup`, and press Enter.
2. In that folder, create a file called `poa.bat` containing:
   ```
   cd /d C:\path\to\poa
   npm start
   ```
   Replace the path with where you cloned P.O.A.

P.O.A then starts every time you log in. On a Mac, add a Login Item that runs `npm start` in the P.O.A folder.
