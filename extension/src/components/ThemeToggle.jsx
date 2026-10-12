import { useTheme } from "../theme.js";
import { G } from "./Art.jsx";

/* Square sun/moon button that switches light ↔ dark. */
export default function ThemeToggle({ style, className = "icon-btn" }) {
  const [theme, toggle] = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Цайвар горим" : "Харанхуй горим";   // light mode / dark mode
  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      title={label}
      aria-label={label}
      aria-pressed={dark}
      style={style}
    >
      {dark ? <G.sun size={16} /> : <G.moon size={16} />}
    </button>
  );
}
