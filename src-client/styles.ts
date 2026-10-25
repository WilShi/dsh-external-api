export const externalApiStyles = String.raw`
.dsh-external-api-root {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 32px;
  color: var(--dsw-alias-label-primary);
}
.dsh-external-api-page {
  width: min(920px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dsh-external-api-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.dsh-external-api-heading h2,
.dsh-external-api-card h3 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
.dsh-external-api-heading h2 { font-size: 18px; }
.dsh-external-api-card h3 { font-size: 14px; }
.dsh-external-api-heading p,
.dsh-external-api-card-heading p {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-external-api-status-badge {
  flex: none;
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 11px;
  font-weight: 600;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-external-api-status-badge[data-state='running'] {
  color: var(--dsw-alias-status-success-label, #0d7a4f);
  background: var(--dsw-alias-status-success-bg, rgba(20, 160, 110, .12));
}
.dsh-external-api-status-badge[data-state='starting'] {
  color: var(--dsw-alias-status-warning-label, #9a6200);
  background: var(--dsw-alias-status-warning-bg, rgba(220, 160, 30, .14));
}
.dsh-external-api-status-badge[data-state='error'] {
  color: var(--dsw-alias-status-danger-label, #b42318);
  background: rgba(217, 45, 32, .1);
}
.dsh-external-api-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--dsw-alias-bg-layer-1);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dsh-external-api-service-card {
  container-name: dsh-external-api-service;
  container-type: inline-size;
}
.dsh-external-api-card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dsh-external-api-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dsh-external-api-switch-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dsh-external-api-switch-copy strong { font-size: 13px; }
.dsh-external-api-switch-copy span,
.dsh-external-api-help {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-external-api-switch {
  width: 18px;
  height: 18px;
  margin: 0;
  flex: none;
  accent-color: var(--dsw-alias-state-business-primary, #155eef);
  cursor: pointer;
}
.dsh-external-api-switch:disabled { cursor: not-allowed; opacity: .55; }
.dsh-external-api-config-grid {
  display: grid;
  grid-template-columns: minmax(180px, .75fr) minmax(280px, 1.25fr);
  gap: 14px 18px;
  align-items: start;
}
.dsh-external-api-config-grid > .dsh-external-api-field {
  display: grid;
  grid-template-rows: auto 36px auto;
  align-content: start;
}
.dsh-external-api-config-grid .dsh-external-api-input,
.dsh-external-api-config-grid .dsh-external-api-address {
  height: 36px;
}
.dsh-external-api-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-external-api-label {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.dsh-external-api-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 8px 10px;
  outline: none;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, transparent);
  font-size: 13px;
}
.dsh-external-api-input:focus {
  border-color: var(--dsw-alias-state-business-primary, #155eef);
}
.dsh-external-api-input:disabled { cursor: not-allowed; opacity: .6; }
.dsh-external-api-input-mono,
.dsh-external-api-mono {
  font-family: var(--dsw-font-family-mono, ui-monospace, Consolas, monospace);
}
.dsh-external-api-address {
  min-height: 36px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-external-api-address code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.dsh-external-api-access-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-external-api-local-url {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-external-api-local-url > span,
.dsh-external-api-local-url > button {
  flex: none;
}
.dsh-external-api-local-url > code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-external-api-link-button {
  border: none;
  background: none;
  padding: 2px 3px;
  color: var(--dsw-alias-label-link, #155eef);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-external-api-link-button:hover { text-decoration: underline; }
.dsh-external-api-link-button:disabled { cursor: not-allowed; opacity: .5; }
.dsh-external-api-service-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  min-width: 0;
  padding-top: 2px;
}
.dsh-external-api-service-footer > .dsh-external-api-banner {
  grid-column: 1;
  min-width: 0;
}
.dsh-external-api-service-footer > .dsh-external-api-actions {
  grid-column: 2;
}
.dsh-external-api-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-top: 0;
}
.dsh-external-api-banner {
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12px;
  line-height: 1.5;
}
.dsh-external-api-banner[data-kind='error'] {
  color: var(--dsw-alias-status-danger-label, #b42318);
  background: rgba(217, 45, 32, .08);
}
.dsh-external-api-banner[data-kind='success'] {
  color: var(--dsw-alias-status-success-label, #0d7a4f);
  background: var(--dsw-alias-status-success-bg, rgba(20, 160, 110, .1));
}
.dsh-external-api-security {
  border-radius: 10px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dsh-external-api-security strong { font-size: 12px; }
.dsh-external-api-security ul {
  margin: 7px 0 0;
  padding-left: 18px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.dsh-external-api-token-form {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.dsh-external-api-token-form .dsh-external-api-field { flex: 1; }
.dsh-external-api-permissions {
  margin: 0;
  padding: 11px 13px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
}
.dsh-external-api-permissions legend {
  padding: 0 5px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 600;
}
.dsh-external-api-permission-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.dsh-external-api-permission-option input {
  width: 15px;
  height: 15px;
  margin: 2px 0 0;
  flex: none;
  accent-color: var(--dsw-alias-state-business-primary, #155eef);
}
.dsh-external-api-permission-option span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-external-api-permission-option strong {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.dsh-external-api-permission-option small,
.dsh-external-api-permissions p {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.dsh-external-api-permissions p {
  grid-column: 1 / -1;
  margin: 0;
}
.dsh-external-api-permissions:disabled { opacity: .65; }
.dsh-external-api-token-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-external-api-token-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(120px, .7fr) minmax(160px, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-external-api-token-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}
.dsh-external-api-token-name strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.dsh-external-api-token-name span,
.dsh-external-api-token-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.dsh-external-api-token-access {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.35;
}
.dsh-external-api-empty,
.dsh-external-api-loading {
  padding: 28px 0;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-external-api-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .38));
}
.dsh-external-api-dialog {
  box-sizing: border-box;
  width: min(560px, 100%);
  border-radius: 14px;
  padding: 20px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .24);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dsh-external-api-dialog h3 { margin: 0; font-size: 16px; }
.dsh-external-api-dialog p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-external-api-secret-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.dsh-external-api-secret-row .dsh-external-api-input { flex: 1; }
.dsh-external-api-secret-warning {
  color: var(--dsw-alias-status-warning-label, #9a6200) !important;
  background: var(--dsw-alias-status-warning-bg, rgba(220, 160, 30, .12));
  border-radius: 8px;
  padding: 9px 11px;
}
@container dsh-external-api-service (max-width: 620px) {
  .dsh-external-api-config-grid,
  .dsh-external-api-service-footer {
    grid-template-columns: minmax(0, 1fr);
  }
  .dsh-external-api-service-footer > .dsh-external-api-banner,
  .dsh-external-api-service-footer > .dsh-external-api-actions {
    grid-column: 1;
  }
}
@media (max-width: 700px) {
  .dsh-external-api-root { padding: 14px 12px 28px; }
  .dsh-external-api-config-grid,
  .dsh-external-api-service-footer { grid-template-columns: minmax(0, 1fr); }
  .dsh-external-api-service-footer > .dsh-external-api-banner,
  .dsh-external-api-service-footer > .dsh-external-api-actions { grid-column: 1; }
  .dsh-external-api-token-form { align-items: stretch; flex-direction: column; }
  .dsh-external-api-permissions { grid-template-columns: 1fr; }
  .dsh-external-api-permissions p { grid-column: auto; }
  .dsh-external-api-token-row { grid-template-columns: 1fr auto; }
  .dsh-external-api-token-row > :nth-child(2),
  .dsh-external-api-token-row > :nth-child(3) { grid-column: 1 / -1; }
}
`
