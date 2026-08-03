# i18n Convention

## Namespace Assignment

| Namespace | Scope |
|-----------|-------|
| common | Shared actions, states, status labels, UI component defaults |
| navigation | Sidebar, breadcrumb, page navigation labels |
| settings | Settings sections and their content |
| projects | Project pages |
| servers | Server pages |
| tasks | Task pages |
| units | Unit pages |
| sidekicks | Sidekick pages |
| workspace | Workspace / terminal area |
| files | File browser |
| git | Git / branch / PR related |
| notifications | Notification center, push notification |
| browser | CDP browser feature |

## Key Naming

- Use dot-separated camelCase: `actions.confirm`, `status.waitingInput`
- Group by feature area, then by element: `appearance.language`, `sections.providers`
- Prefix with namespace when referencing across namespaces: `t('common:actions.cancel')`
- Within a namespace, omit the prefix: `t('actions.cancel')` (when `useTranslation('common')`)

## labelKey Pattern

For constant arrays (settings sections, nav items), store a `labelKey` string
instead of a display label. Resolve at render time:

```tsx
const { t } = useTranslation();
// ...
{t(section.labelKey)}
```

## Component Default Text

Components with default text use the `??` pattern — caller overrides take precedence:

```tsx
{confirmLabel ?? t('common:actions.confirm')}
```

## Interpolation

Use `{{variableName}}` syntax:

```json
{ "backTo": "Back to {{label}}" }
```

```tsx
t('navigation.backTo', { label: 'Settings' })
```

## Pluralization

Use i18next `_one` / `_other` suffixes:

```json
{
  "itemCount_one": "{{count}} item",
  "itemCount_other": "{{count}} items"
}
```

## Adding Translations

1. Add keys to both `locales/en/<namespace>.json` and `locales/ja/<namespace>.json`
2. Run `npx -w packages/frontend vitest run src/i18n/resources.test.ts` to verify key parity
3. Import `useTranslation` from `react-i18next` in the component
