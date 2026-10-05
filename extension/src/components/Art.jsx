/* Hand-drawn monochrome product illustrations used in the hero, category
   tiles and trending cards (stand-ins for product photography). */

/* `Icons` and `G` are lookup objects of tiny components. Fast refresh then
   reloads this whole file on edit instead of hot-swapping, which is fine. */
/* eslint-disable react-refresh/only-export-components */

const INK = "#111";
const SOFT = "#d9d9d9";
const SHADOW = "#e1e1e1";

/* ── Large illustrations (viewBox 200×200) ──────────────────────── */

export const PhoneArt = (p) => (
  <svg viewBox="0 0 200 200" aria-hidden="true" {...p}>
    <ellipse cx="100" cy="188" rx="48" ry="6" fill={SHADOW} />
    <rect x="58" y="22" width="76" height="154" rx="12" transform="rotate(-10 96 99)" fill="none" stroke="#cfcfcf" strokeWidth="1.5" />
    <rect x="64" y="16" width="76" height="160" rx="13" fill={INK} />
    <rect x="69" y="21" width="66" height="150" rx="9" fill="#fff" />
    <rect x="90" y="25" width="24" height="6" rx="3" fill={INK} />
    <rect x="76" y="40" width="22" height="3" fill={SOFT} />
    <rect x="116" y="39" width="12" height="5" fill={INK} />
    <rect x="76" y="50" width="52" height="46" fill="#f0f0f0" />
    <circle cx="102" cy="73" r="13" fill="none" stroke={INK} strokeWidth="2" />
    <path d="m111 82 7 7" stroke={INK} strokeWidth="2.5" strokeLinecap="round" />
    <rect x="76" y="104" width="40" height="4" fill={INK} />
    <rect x="76" y="113" width="30" height="3" fill={SOFT} />
    <rect x="76" y="122" width="24" height="6" fill={INK} />
    <rect x="76" y="140" width="52" height="16" fill={INK} />
    <rect x="90" y="146" width="24" height="3" fill="#fff" />
  </svg>
);

export const HeadphonesArt = (p) => (
  <svg viewBox="0 0 200 200" aria-hidden="true" {...p}>
    <ellipse cx="100" cy="186" rx="56" ry="6" fill={SHADOW} />
    <path d="M44 118C44 52 156 52 156 118" fill="none" stroke={INK} strokeWidth="11" strokeLinecap="round" />
    <path d="M56 112C58 66 142 66 144 112" fill="none" stroke={SOFT} strokeWidth="3" strokeLinecap="round" />
    <rect x="28" y="104" width="36" height="62" rx="14" fill={INK} />
    <rect x="136" y="104" width="36" height="62" rx="14" fill={INK} />
    <rect x="58" y="110" width="12" height="50" rx="5" fill={SOFT} />
    <rect x="130" y="110" width="12" height="50" rx="5" fill={SOFT} />
    <circle cx="46" cy="135" r="6" fill="none" stroke="#555" strokeWidth="2" />
    <circle cx="154" cy="135" r="6" fill="none" stroke="#555" strokeWidth="2" />
  </svg>
);

export const LaptopArt = (p) => (
  <svg viewBox="0 0 200 200" aria-hidden="true" {...p}>
    <ellipse cx="100" cy="164" rx="82" ry="6" fill={SHADOW} />
    <rect x="38" y="42" width="124" height="86" rx="6" fill={INK} />
    <rect x="44" y="48" width="112" height="74" fill="#fff" />
    <rect x="52" y="56" width="30" height="4" fill={INK} />
    <rect x="52" y="68" width="44" height="44" fill="#f0f0f0" />
    <rect x="104" y="70" width="44" height="4" fill={INK} />
    <rect x="104" y="80" width="34" height="3" fill={SOFT} />
    <rect x="104" y="88" width="38" height="3" fill={SOFT} />
    <rect x="104" y="100" width="28" height="9" fill={INK} />
    <path d="M18 132h164l-10 20H28z" fill="#efefef" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <rect x="86" y="132" width="28" height="5" fill={INK} />
  </svg>
);

export const SneakerArt = (p) => (
  <svg viewBox="0 0 200 160" aria-hidden="true" {...p}>
    <ellipse cx="100" cy="146" rx="84" ry="5" fill={SHADOW} />
    <path d="M18 116h158c8 0 10 8 8 14l-2 6H22c-6 0-8-6-6-12z" fill="#fff" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <path d="M20 116c0-26 10-40 30-42l30-26c8-6 16-6 22 0l38 38c16 6 32 14 36 30z" fill="#fff" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <path d="M46 100c30-2 60 2 98-4" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
    <path d="m86 58 12 10M80 64l12 10M74 70l12 10" stroke={INK} strokeWidth="2" strokeLinecap="round" />
    <path d="M24 126h152" stroke={SOFT} strokeWidth="2" />
  </svg>
);

export const WatchArt = (p) => (
  <svg viewBox="0 0 200 200" aria-hidden="true" {...p}>
    <rect x="80" y="10" width="40" height="56" rx="6" fill={INK} />
    <rect x="80" y="134" width="40" height="56" rx="6" fill={INK} />
    <path d="M86 22h28M86 34h28M86 168h28M86 180h28" stroke="#444" strokeWidth="2" />
    <circle cx="100" cy="100" r="46" fill={INK} />
    <circle cx="100" cy="100" r="37" fill="#fff" />
    <rect x="146" y="93" width="8" height="14" rx="2" fill={INK} />
    <path d="M100 70v6M100 124v6M70 100h6M124 100h6" stroke={INK} strokeWidth="2.5" />
    <path d="M100 100V80M100 100l14 9" stroke={INK} strokeWidth="3" strokeLinecap="round" />
    <circle cx="100" cy="100" r="3.5" fill={INK} />
  </svg>
);

export const BagArt = (p) => (
  <svg viewBox="0 0 200 200" aria-hidden="true" {...p}>
    <ellipse cx="100" cy="186" rx="70" ry="6" fill={SHADOW} />
    <path d="M70 84c0-44 60-44 60 0" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
    <path d="M44 80h112l14 98H30z" fill="#f6f6f6" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <path d="M44 80l56 40 56-40" fill="none" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <rect x="92" y="114" width="16" height="14" fill={INK} />
    <circle cx="70" cy="86" r="4" fill={INK} />
    <circle cx="130" cy="86" r="4" fill={INK} />
  </svg>
);

/* ── Small line icons (24×24, stroke = currentColor) ─────────────── */

const Line = ({ size = 56, sw = 1.3, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icons = {
  phone:      (p) => <Line {...p}><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></Line>,
  headphones: (p) => <Line {...p}><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" /></Line>,
  laptop:     (p) => <Line {...p}><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></Line>,
  mouse:      (p) => <Line {...p}><rect x="5" y="2" width="14" height="20" rx="7" /><path d="M12 6v4" /></Line>,
  watch:      (p) => <Line {...p}><circle cx="12" cy="12" r="6" /><path d="M12 10v2l1 1" /><path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05" /><path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05" /></Line>,
  shirt:      (p) => <Line {...p}><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" /></Line>,
  camera:     (p) => <Line {...p}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></Line>,
  gamepad:    (p) => <Line {...p}><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01" /><rect x="2" y="6" width="20" height="12" rx="2" /></Line>,
  keyboard:   (p) => <Line {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" /></Line>,
  speaker:    (p) => <Line {...p}><rect x="4" y="2" width="16" height="20" rx="2" /><circle cx="12" cy="14" r="4" /><path d="M12 6h.01" /></Line>,
  bag:        (p) => <Line {...p}><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></Line>,
  shoe:       (p) => <Line {...p}><path d="M2 18h19a1 1 0 0 0 1-1 3 3 0 0 0-2.4-2.9L15 13l-3-4-2 1-1.5-2H5a2 2 0 0 0-2 2v8" /><path d="M9 13l1.5-1M11 15l1.5-1" /></Line>,
  tablet:     (p) => <Line {...p}><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M12 18h.01" /></Line>,
  monitor:    (p) => <Line {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Line>,
};

/* ── UI glyphs ──────────────────────────────────────────────────── */

const Glyph = ({ size = 16, sw = 1.8, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const G = {
  search:  (p) => <Glyph {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Glyph>,
  user:    (p) => <Glyph {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Glyph>,
  logout:  (p) => <Glyph {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></Glyph>,
  chat:    (p) => <Glyph {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Glyph>,
  x:       (p) => <Glyph {...p}><path d="M18 6 6 18M6 6l12 12" /></Glyph>,
  left:    (p) => <Glyph {...p}><path d="m15 18-6-6 6-6" /></Glyph>,
  right:   (p) => <Glyph {...p}><path d="m9 18 6-6-6-6" /></Glyph>,
  arrow:   (p) => <Glyph {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Glyph>,
  send:    (p) => <Glyph {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></Glyph>,
  trash:   (p) => <Glyph {...p}><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M9 6V4h6v2" /></Glyph>,
  filter:  (p) => <Glyph {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></Glyph>,
  spark:   (p) => <Glyph {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></Glyph>,
  clock:   (p) => <Glyph {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Glyph>,
  shield:  (p) => <Glyph {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Glyph>,
  package: (p) => <Glyph {...p}><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></Glyph>,
  /* small gift-box ornament used under section titles */
  ornament:(p) => <Glyph size={18} sw={1.4} {...p}><rect x="4" y="9" width="16" height="11" /><path d="M2 9h20M12 9v11M12 9c-2-4-6-4-6-1s6 1 6 1 6 2 6-1-4-3-6 1" /></Glyph>,
};
