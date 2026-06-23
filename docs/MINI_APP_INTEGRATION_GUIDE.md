# Mini-App Integration Guide for Dasun App

This guide explains how to build a mini-app that integrates seamlessly with the main dasun.app dashboard shell, UI layouts, and the centralized authentication platform.

## 1. Authentication and Central Platform Constraints

The dasun.app ecosystem is designed with a centralized auth and identity platform:
- **domain.x** acts as the central auth authority.
- Child applications (m.domain.x/app-name) reuse the central login and session.
- Authentication uses an opaque shared session cookie and central session introspection, rather than passing a JWT directly to apps.
- **Each app maintains its own separate database**, although the central subscription and identity truth is kept in dasun.app.

### Required API Introspection
Your backend should not invent its own login. Instead, it must lazily provision an app-local user by calling the central auth introspection endpoint:
- **Introspection Check:** domain.x/api/internal/session/introspect (or equivalent endpoint).
- You can request public, guest, or equired access mode on routes.
- **Guest Sessions:** Handled locally by the app, lasting 3 days.

### Login / Logout UX
- **Login:** Redirect unauthenticated users needing access to the main portal login (domain.x/login?return_to=<your-app-url>).
- **Logout:** Send users to the central logout so it clears the global session. 

## 2. Shared Layout & Styling

To maintain visual consistency with the main dashboard, your mini-app should adopt the same foundational structure and CSS variable schema.

### Core Structure (The Shell Frame)
The standard layout consists of:
1. **Background Backdrops:** shell-backdrop--one and shell-backdrop--two.
2. **Top Navigation (shell-topbar):** Usually handled by the main dashboard if embedded, but if standalone, include the ShellLayout standard components.
3. **Sub-Navigation (shell-subnav - Optional):** Used for navigating inside the mini-app features.
4. **Main Content (shell-main__content):** The primary area for your mini-app UI (cards, forms, datagrids).

### CSS Schema

Do not hardcode colors in your app. Rely on the shared CSS custom properties.

**Typography and Metrics:**
- --ds-radius-card: 1rem;
- --ds-radius-pill: 999px;
- --ds-shell-max-width: 1216px;
- --ds-shell-section-gap: clamp(1.25rem, 2vw, 1.5rem);
- --ds-shadow-card: 0 28px 68px rgba(18, 9, 4, 0.12); (Changes dynamically in Dark Mode)

**Colors (Light Theme Defaults):**
- **Backgrounds:** --ds-bg (#fffdf9) and --ds-bg-soft (#f9efe4).
- **Surfaces (Cards):** --ds-surface (rgba(246, 230, 201, 0.85)) and --ds-surface-strong (rgba(255, 253, 249, 0.95)).
- **Text:** --ds-text (#615044) and --ds-text-muted (#866b55).
- **Primary Elements:** --ds-primary (#b98a63) and --ds-primary-strong (#866b55).
- **Borders:** --ds-border (rgba(115, 91, 75, 0.16)) and --ds-border-strong (rgba(115, 91, 75, 0.28)).
- **Backdrops (for gradients):** --ds-backdrop-one and --ds-backdrop-two.

### Standard Layout Implementation Example (Vue 3 / HTML)

`html
<div class="shell-frame">
  <!-- Gradient backdrops -->
  <div class="shell-backdrop shell-backdrop--one"></div>
  <div class="shell-backdrop shell-backdrop--two"></div>

  <!-- Main Top Bar -->
  <header class="shell-topbar">
    <div class="shell-topbar__inner">
      <div class="shell-brand">Your App Name</div>
      <!-- User / Theme Toggles go here -->
    </div>
  </header>

  <main class="shell-main">
    <!-- Sub Nav (Optional) -->
    <div class="shell-subnav">
      <nav class="shell-nav">
        <a class="shell-nav__link active" href="#">Home</a>
        <a class="shell-nav__link" href="#">Settings</a>
      </nav>
    </div>

    <!-- Main Content Area -->
    <div class="shell-main__content">
      <div class="ds-card">
        <h3>Card Title</h3>
        <p>This is a standard content card matching the main app layout.</p>
      </div>
    </div>
  </main>
</div>
`

*Note: For the card CSS class (ds-card), you would typically apply:*
`css
.ds-card {
  background: var(--ds-surface);
  border-radius: var(--ds-radius-card);
  box-shadow: var(--ds-shadow-card);
  padding: var(--ds-shell-section-gap);
  border: 1px solid var(--ds-border);
}
`

## 3. Creating and Registering the App

Once your mini-app is complete:
- Your application must expose a home_url that functions as its entrypoint.
- Applications can launch in 3 modes: same_tab, 
ew_tab, or mbedded.
- Apps support 4 visibilities: public, login_required, dmin_only, or hidden.
- Ensure your backend uses a dedicated database decoupled from the central platform.

## Summary Checklist for Mini-App Agents
- [ ] Connect auth strictly via central introspection (no standalone JWT login).
- [ ] Implement guest sessions correctly with a 3-day TTL.
- [ ] Adapt layout to the .shell-frame > .shell-main DOM hierarchy.
- [ ] Style using --ds-* custom CSS properties to automatically inherit light/dark modes.
- [ ] Do not mutate central databases directly.
