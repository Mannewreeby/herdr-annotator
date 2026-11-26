"""Generate a private tabs mod without changing Herdr's shipped mod."""
import json
import re

NEW_MENU_CALL = re.compile(r'openOverlay\(\{ mod: "new-menu"(?P<rest>[^}]*)\}\)')


def integrated_tabs(source, new_menu=None):
    """new_menu: {"mod": name, "width"?: px, "height"?: px} opened by the + button instead of Herdr's new-menu."""
    anchor = '.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported shipped tabs mod: Changes button changed; no files were installed")
    result = 'import { openReview } from "./launcher.js";\n' + source.replace(anchor, '''.when(enabled.includes("changes"), el => el.child(h_flex().gap(0).items_center()
        .child(panelButton("changes", "Changes", "mods/changes/changes.svg"))
        .child(div().id("panel-review-full").h(26).px(8).flex_none().flex().items_center().rounded(6)
          .border_l(1).border_color(t.border).text_size(12).text_color(this.reviewError ? t.ansi1 : t.muted)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click((_e, cx) => openReview(this, cx))
          .child(this.openingReview ? "…" : this.reviewError ? `Retry ↗ · ${this.reviewError}` : "↗"))))''')
    if not new_menu:
        return result
    if len(NEW_MENU_CALL.findall(result)) != 1:
        raise ValueError("Unsupported shipped tabs mod: the + menu changed; no files were installed")

    def personal(match):
        rest = match.group("rest")
        for key in ("width", "height"):
            if key in new_menu:
                rest = re.sub(rf"{key}: \d+", f"{key}: {int(new_menu[key])}", rest)
        return f'openOverlay({{ mod: {json.dumps(new_menu["mod"])}{rest}}})'
    return NEW_MENU_CALL.sub(personal, result)
