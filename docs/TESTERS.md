# Testing HA Paper

Thanks for trying HA Paper. Our goal: a new owner goes from a boxed X4 Pro to their Home Assistant dashboard on the
display in under 15 minutes. This page is the script. Flashing details: [FLASHING.md](FLASHING.md).

## What you need

- An Xteink X4 Pro and a USB-C data cable.
- A desktop computer with Chrome or Edge (the web flasher uses Web Serial; Firefox, Safari and phones can't).
- Your 2.4 GHz Wi-Fi name and password.
- Your Home Assistant URL and an account that can log in.
- A timer (your phone is fine).

## Install (timed)

1. **Start the timer** when you open the web flasher page.
2. **Flash.** Follow the steps on the page: connect the X4 Pro over USB (no buttons),
   Connect, Read backup (keep the `.bin` file somewhere safe; it restores the original firmware), Install.
3. **Wi-Fi.** Leave the cable in. Step 4 on the flasher page lists the networks the display sees; pick yours and
   type the password. If the page says the display did not answer, unplug the cable and join Wi-Fi on the display
   itself (pick a network, or *Set up from phone*).
4. **Link Home Assistant.** The display shows a QR code and an address like `http://ha-paper-XXXX.local` (XXXX is
   different per display), with its IP next to it. Scan the QR, or open the address (or the IP, if `.local` doesn't
   resolve) on a device on the same Wi-Fi. Press **Sign in with Home Assistant** and log in with your HA account.
5. **Stop the timer** when the first dashboard is visible on the display. Write down the time.

Also write down every place you got stuck or had to guess, with the step number. That is the most useful part.

## Live with it for 3 days

- [ ] Screens are readable from 2 m away.
- [ ] Touch and buttons do what you expect. Note any press that did nothing or did the wrong thing.
- [ ] Quiet hours start and end at the times you set ("Back at 07:00"), and the display looks right in the morning.
- [ ] Restart your router. The display reconnects on its own. Note how long it took.
- [ ] Battery: note the battery % at the same time each day. Write down the drop per day.
- [ ] Anything that looked wrong, slow, or ugly.

## Report

Open an issue with the **Bug report** form on GitHub (Issues › New issue › Bug report). One issue per problem.
For a run with no problems, still send your install time, the battery % per day and your stuck points; open a
Bug report and write "no bug, tester report" in *What happened*.

The form asks for the Diagnostics JSON: in the web console go to Device › Diagnostics and press copy. It holds no
passwords, but it does hold your Home Assistant URL; replace it with `<redacted>` if you prefer.
