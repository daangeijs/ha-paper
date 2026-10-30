# Now playing volume slider (issue #351)

- The firmware draws the new level when the finger lifts, not while it moves: the input task sends no move events (a
  touch is one Tap, Swipe or Drag at release) and a partial takes ~0.5 s, so a live bar would trail the finger. The
  emulator shows the level live during a drag. One `volume_set` on release on both.
- A drag under 60 px is a tap at the touch-down point (the SDK's tap release slop), so short drags set the level where
  the finger landed. A fast horizontal drag that starts on the bar sets the level instead of turning the page.
- No mute toggle and no Prev / Next ±5 %: the keys turn pages and there is no tile focus to give them to.
