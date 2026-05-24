# Design System Documentation

## Overview

This document describes the design system tokens, components, and patterns used in the Ownership & Revenue Agent application.

The design system is implemented entirely through CSS custom properties (variables) defined in `styles.css`, with support for both light and dark themes.

---

## Typography Scale

Base font size: 14px

| Token | Size | Use Case |
|-------|------|----------|
| `--text-xs` | 10px | Chip labels, field labels, small metadata |
| `--text-sm` | 11px | Secondary text, field hints, component labels |
| `--text-base` | 13px | Button text, default component text |
| `--text-md` | 14px | Body text (default) |
| `--text-lg` | 16px | Heading 3, brand title |
| `--text-xl` | 18px | Column title |
| `--text-2xl` | 22px | Detail panel name |
| `--text-3xl` | 26px | Large revenue display |

### Implementation

Use typography tokens in CSS:

```css
.my-component {
  font-size: var(--text-base);
}
```

In JSX with inline styles:
```jsx
<span style={{ fontSize: 'var(--text-sm)' }}>Small text</span>
```

---

## Spacing Scale

Base unit: 4px

| Token | Value | Use Case |
|-------|-------|----------|
| `--space-1` | 2px | Fine micro spacing |
| `--space-1_5` | 4px | Component internal gaps |
| `--space-2` | 6px | Tight padding |
| `--space-2_5` | 8px | Standard small spacing |
| `--space-3` | 10px | Form field padding |
| `--space-3_5` | 12px | Component gaps |
| `--space-4` | 14px | Medium spacing |
| `--space-5` | 16px | Standard padding |
| `--space-6` | 18px | Large spacing |
| `--space-7` | 20px | Extra large spacing |
| `--space-8` | 24px | Layout spacing |
| `--space-9` | 28px | Section spacing |
| `--space-10` | 32px | Large section spacing |
| `--space-12` | 36px | Large padding |
| `--space-14` | 40px | XL spacing |
| `--space-16` | 48px | Header/footer spacing |
| `--space-20` | 56px | Large gap |
| `--space-24` | 64px | Bottom spacing |

---

## Border Radius

| Token | Value | Use Case |
|-------|-------|----------|
| `--radius-xs` | 2px | Chip corners, very small elements |
| `--radius-sm` | 4px | Toggle buttons, small components |
| `--radius-md` | 6px | Buttons, inputs, default radius |
| `--radius-lg` | 8px | Cards, panels, standard radius |
| `--radius-xl` | 10px | Large containers, form containers |

---

## Color Tokens

### Light Theme

**Backgrounds:**
- `--bg`: #ffffff (main background)
- `--bg-elevated`: #fafafa (elevated backgrounds)
- `--surface`: #f7f7f8 (surface/cards)
- `--surface-2`: #ffffff (secondary surface)

**Text:**
- `--text`: #18181b (primary text)
- `--text-muted`: #52525b (secondary text)
- `--text-subtle`: #a1a1aa (tertiary text)

**Accent:**
- `--accent`: #0891b2 (primary action, cyan)
- `--accent-hover`: #0e7490 (hover state)
- `--accent-soft`: #ecfeff (soft background)
- `--accent-soft-border`: #a5f3fc (soft border)

**Semantic:**
- `--success`: #16a34a (positive, green)
- `--warning`: #b45309 (caution, amber)
- `--warning-bg`: #fffbeb
- `--warning-border`: #fcd34d
- `--danger`: #b91c1c (error, red)
- `--danger-bg`: #fef2f2
- `--danger-border`: #fecaca
- `--info-bg`: #eff6ff
- `--info-border`: #bfdbfe

### Dark Theme

Same structure with dark mode values. Activate with `[data-theme="dark"]`.

---

## Component Library

### Buttons

**Base button:**
```jsx
<button className="btn">Default</button>
<button className="btn btn-primary">Primary</button>
<button className="btn btn-ghost">Ghost</button>
<button className="btn btn-sm">Small</button>
<button className="btn btn-icon">⚙️</button>
```

Styles:
- `.btn` - Default button
- `.btn-primary` - Primary action
- `.btn-ghost` - Transparent, secondary
- `.btn-sm` - Small size
- `.btn-icon` - Icon-only button

### Cards

```jsx
<div className="card">Card content</div>
<div className="card card-pad-lg">Large padding</div>
```

### Banners

```jsx
<div className="banner banner-info">ℹ️ Information</div>
<div className="banner banner-warning">⚠️ Warning</div>
<div className="banner banner-danger">❌ Error</div>
<div className="banner banner-success">✓ Success</div>
```

### Chips

```jsx
<span className="chip">Neutral</span>
<span className="chip chip-accent">Accent</span>
<span className="chip chip-warning">Warning</span>
<span className="chip chip-danger">Danger</span>
```

### Inputs & Selects

```jsx
<input type="text" className="input" placeholder="Text input" />
<select className="select">
  <option>Option 1</option>
  <option>Option 2</option>
</select>
```

### Forms

```jsx
<form className="input-form">
  <div>
    <label className="field-label">Label</label>
    <input className="input" type="text" />
  </div>
  <button className="btn btn-primary">Submit</button>
</form>
```

### Stepper (Progress Indicator)

```jsx
<div className="stepper">
  <div className="step done">
    <span className="step-dot">1</span>
    Completed
  </div>
  <span className="step-sep"></span>
  <div className="step active">
    <span className="step-dot">2</span>
    In Progress
  </div>
  <span className="step-sep"></span>
  <div className="step">
    <span className="step-dot">3</span>
    Pending
  </div>
</div>
```

States:
- `.step.done` - Completed
- `.step.active` - In progress (animates)
- `.step` - Pending

### Trees & Ownership Nodes

```jsx
<div className="tree">
  <div className="tree-section-label">Parents</div>
  <div className="tree-node focal">
    <div className="tree-node-main">
      <span className="tree-node-name">Acme Corp</span>
      <div className="tree-node-meta">
        <span>Public Company</span>
      </div>
    </div>
    <span className="tree-node-rev">$50B</span>
  </div>
</div>
```

States:
- `.tree-node.focal` - Focal entity (highlighted)
- `.tree-node.individual` - Individual/person (dashed border, italic name)
- `.tree-node.selected` - Currently selected

### Flow Nodes (Graph)

Same structure as tree nodes, but with `.flow-node` class:
```jsx
<div className="flow-node focal">
  <div className="flow-node-name">Company Name</div>
  <div className="flow-node-domain">example.com</div>
  <div className="flow-node-meta">
    <span className="chip chip-accent">focal</span>
  </div>
</div>
```

### Strategic Control Section

```jsx
<div className="strategic-item">
  <div className="strategic-head">
    <span className="strategic-rel">OWNS</span>
    <span className="strategic-entity">Subsidiary Inc</span>
  </div>
  <div className="strategic-details">30% stake</div>
  <div className="strategic-source">SEC Filing XYZ</div>
</div>
```

### Co-owners Section

```jsx
<div className="co-owners">
  <div className="co-owners-head">
    Co-owners <span className="co-owners-sub">(2)</span>
  </div>
  <div className="co-owner-row">
    <div className="co-owner-icon chip-accent">👥</div>
    <div className="co-owner-main">
      <div className="co-owner-name">John Doe</div>
      <div className="co-owner-meta">
        <span className="chip chip-accent">Director</span>
      </div>
      <div className="co-owner-evidence">Board position</div>
      <div className="co-owner-source">company.com/team</div>
    </div>
    <div className="co-owner-stake">25%</div>
  </div>
</div>
```

**Note:** Bug #2 tracking - Co-owners section styling may have layout issues with parent highlighting. See code for details.

### Revenue Cards

```jsx
<div className="rev-card">
  <span className="rev-big">$50B</span>
  <div className="rev-range">$45B - $55B</div>
  <div className="rev-foot">
    <span>Based on public data</span>
  </div>
</div>
```

### Signal Rows (Evidence)

```jsx
<div className="signal-row">
  <span className="signal-type">UBO</span>
  <div>
    <span className="signal-label">Ultimate Beneficial Owner</span>
    <div className="signal-value">Jane Smith</div>
    <div className="signal-source">Panama Papers</div>
  </div>
  <span className="signal-weight">HIGH</span>
</div>
```

### Logs Panel

```jsx
<div className="logs-panel">
  <button className="logs-toggle">📋 Execution Logs</button>
  <div className="logs-body">
    <div className="log-row">
      <span className="log-idx">1</span>
      <span className="log-kind log-kind-phase">[PHASE]</span>
      <span className="log-text">Analyzing ownership...</span>
    </div>
  </div>
</div>
```

Log types:
- `.log-kind-phase` - Phase transition
- `.log-kind-search` - Search action
- `.log-kind-results` - Successful result
- `.log-kind-error` - Error message

### Monospace Text

Use `.text-mono` or `.mono` class for monospaced font (JetBrains Mono):

```jsx
<span className="text-mono">example.com</span>
<div className="mono">API Response</div>
```

---

## Layout Patterns

### Responsive Grid Layout

```jsx
<div className="report-grid">
  <div className="left-col">
    {/* Main content */}
  </div>
  <div className="right-col">
    {/* Sticky sidebar - becomes static on mobile */}
  </div>
</div>
```

Breakpoints:
- Desktop: 2-column layout
- 960px and below: 1-column layout
- Right column becomes static (non-sticky)

### Container

```jsx
<div className="container">
  {/* Content max-width 1280px, centered */}
</div>
```

### Sections

```jsx
<section className="section">
  <div className="section-head">
    <span className="section-title">Section Title</span>
  </div>
  {/* Content */}
</section>
```

---

## Utility Classes

| Class | Purpose |
|-------|---------|
| `.text-mono` / `.mono` | Apply monospace font |
| `.state-focal` | Apply focal state styling |
| `.no-print` | Hide element on print/PDF |

---

## Theme Switching

The app supports light and dark themes via `data-theme` attribute:

```html
<html data-theme="light"> <!-- or "dark" -->
```

CSS automatically adjusts all color variables:

```css
:root, [data-theme='light'] { /* light colors */ }
[data-theme='dark'] { /* dark colors */ }
```

---

## Known Issues

### Bug #2: Co-owners Section Layout

The `.co-owner-parent` styling (line 399 in styles.css) may have spacing/margin issues when highlighting parent rows with the accent soft background.

Symptoms:
- Padding/margin inconsistency on co-owner rows
- Parent highlighting background not spanning correctly

Workaround: Review `.co-owner-parent` margin and padding adjustments.

---

## Conventions

### Naming Pattern

- Components: `.component-name`
- Variants: `.component-variant` (e.g., `.btn-primary`)
- States: `.component.state` (e.g., `.tree-node.focal`)
- Nested elements: `.component-element` (e.g., `.tree-node-name`)

### Spacing Usage

- Gap between elements: `gap` property with `--space-*` tokens
- Padding inside containers: `padding` with `--space-*` tokens
- Margin for vertical rhythm: `margin-top`, `margin-bottom` with `--space-*` tokens

### Color Usage

- Text: Always use semantic tokens (`--text`, `--text-muted`, `--text-subtle`)
- Backgrounds: Use `--bg`, `--surface`, `--surface-2`
- Interactive: Use `--accent` and variants
- Status: Use `--success`, `--warning`, `--danger` as appropriate

---

## Responsive Design

Mobile-first approach with breakpoints:

```css
/* Default: mobile styles */
.responsive-element { }

/* Tablet and above */
@media (max-width: 960px) { }

/* Smaller mobile */
@media (max-width: 640px) { }

/* Very small mobile */
@media (max-width: 480px) { }
```

---

## Print Styles

Print-optimized styles included. Use `.no-print` to hide elements when printing:

```jsx
<button className="no-print">Download</button> {/* Hidden when printing */}
```

Print optimizations:
- White background, black text
- No shadows on cards
- Single-column layout
- Page break rules for cards/sections

---

## Future Improvements

- [ ] Storybook component library for visual testing
- [ ] Component variants documentation
- [ ] Accessibility checklist
- [ ] Animation/transition standards
- [ ] Shadow and depth system refinement
- [ ] Bug #2 resolution and documentation

