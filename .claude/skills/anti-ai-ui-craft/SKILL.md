---
name: anti-ai-ui-craft
description: Guidelines for crafting distinctive, bespoke, human-designed UI interfaces without generic AI tropes ("AI slop", overused purple gradients, floaty blur cards, and fake placeholder designs). Use when designing, styling, or creating frontend pages and components.
metadata:
  version: "1.0.0"
  target: "ui-design-excellence"
---

# Anti-AI UI Craft: Principles for Human-Designed Interfaces

AI-generated web UIs often suffer from predictable, cliché aesthetics: identical purple/indigo glow gradients, blurry glassmorphism cards with low contrast, generic circular icon badges, and hollow marketing copy.

This skill provides strict aesthetic rules to build **distinctive, tactile, production-grade interfaces that look crafted by world-class product designers**.

---

## 1. What to NEVER Do (Banished "AI Slop" Tropes)

❌ **NO generic purple/violet/magenta radial glows** on pure black `#000000` backgrounds.  
❌ **NO unreadable glassmorphism** (`backdrop-blur` cards with low contrast and washed-out text).  
❌ **NO repetitive 3-column feature cards** with a generic circle icon at the top and 2 lines of buzzwords.  
❌ **NO floating useless decorative shapes** (blurred orbs, glowing geometric outlines) that serve no purpose.  
❌ **NO generic placeholder copy** ("Supercharge your workflow with next-gen synergy"). Use realistic, domain-specific text and numbers.  
❌ **NO plain browser defaults** for buttons, inputs, scrollbars, or focus states.

---

## 2. Hallmarks of Bespoke, Human-Crafted Design

### A. Sophisticated Color Palettes & Contrast
- **Rich Neutrals**: Instead of pure `#000000`, use deep slate (`#0B0F17`), warm zinc (`#0E0F12`), or dark graphite (`#121316`).
- **Intentional Accent Color**: Pick ONE purposeful primary brand accent (e.g., Electric Cobalt `#2563EB`, Deep Emerald `#059669`, Warm Amber `#D97706`, Crimson Terracotta `#E11D48`) and pair it with monochromatic neutral variations.
- **Strict Accessibility (WCAG AAA/AA)**: Ensure body text contrast ratio is at least `4.5:1` against backgrounds.

### B. Crisp Surfaces & Tactile Depth
- **Subtle 1px Borders**: Define containers with crisp, high-precision borders:
  ```css
  /* Light mode */
  border: 1px solid rgba(0, 0, 0, 0.08);
  /* Dark mode */
  border: 1px solid rgba(255, 255, 255, 0.08);
  ```
- **Layered Elevation**: Use refined, multi-step shadows rather than large blurry glows:
  ```css
  box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05), 0 4px 12px 0 rgba(0,0,0,0.03);
  ```

### C. Strong Typographic Hierarchy
- **Characterful Typography**: Use high-grade modern font stacks (Geist, Inter, Plus Jakarta Sans, Instrument Serif, Outfit).
- **Scale & Weight**: Establish distinct hierarchy:
  - Page Titles: `text-2xl` to `text-4xl` with `font-semibold tracking-tight`.
  - Section Headers: `text-lg` with `font-medium`.
  - Body: `text-sm leading-relaxed text-muted-foreground`.
  - Meta/Badges: `text-xs font-mono uppercase tracking-wider`.

### D. Data Density & Purposeful UI Elements
- Real UI needs real utility:
  - Actionable **data tables** with sorting, search, and pagination.
  - Interactive **filter pills**, tabs, and segmented controls.
  - **Keyboard shortcut badges** (e.g., `<kbd class="px-1.5 py-0.5 text-xs bg-muted rounded border">⌘K</kbd>`).
  - Tactile buttons with clear active press states (`active:scale-[0.98]`).
  - Meaningful **Empty States** with an illustrative action button rather than blank space.

### E. Meaningful Micro-Interactions
- Smooth transition durations (`150ms` - `200ms` with `ease-out`).
- Hover states must subtly change background lightness or border brightness, not trigger distracting jumpy animations.
- Skeleton loaders that match the exact shape of incoming content.
