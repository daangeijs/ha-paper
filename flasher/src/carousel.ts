// Screens carousel (eink-ha-os#239): crossfade every 4 s, pause on hover/focus, dots to pick, still under reduced motion.

export const SLIDE_MS = 4000;

export function startCarousel(root: HTMLElement, interval = SLIDE_MS): void {
  const slides = [...root.querySelectorAll<HTMLElement>(".slide")];
  const dots = root.querySelector<HTMLElement>(".dots");
  if (slides.length < 2 || !dots) return;
  let i = 0;
  let paused = false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const buttons = slides.map((s, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dot";
    b.setAttribute("aria-label", s.querySelector("figcaption")?.textContent ?? `Screen ${n + 1}`);
    b.addEventListener("click", () => show(n));
    dots.append(b);
    return b;
  });

  function show(n: number) {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => {
      s.classList.toggle("active", k === i);
      s.setAttribute("aria-hidden", k === i ? "false" : "true");
      s.querySelector("img")?.removeAttribute("loading"); // the next one is about to show
    });
    buttons.forEach((b, k) => b.setAttribute("aria-current", k === i ? "true" : "false"));
  }

  show(0);
  root.addEventListener("mouseenter", () => (paused = true));
  root.addEventListener("mouseleave", () => (paused = false));
  root.addEventListener("focusin", () => (paused = true));
  root.addEventListener("focusout", () => (paused = false));
  // Reduced motion: no automatic turning; the dots still work.
  if (!reduced) setInterval(() => !paused && !document.hidden && show(i + 1), interval);
}
