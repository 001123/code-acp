import { useState } from "react";
import type { CatalogAgent, CatalogState } from "../../agentCatalog";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import { post } from "./post";
import downloadIcon from "@tabler/icons/outline/download.svg";
import externalLinkIcon from "@tabler/icons/outline/external-link.svg";
import licenseIcon from "@tabler/icons/outline/license.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";
import packageIcon from "@tabler/icons/outline/package.svg";
import playIcon from "@tabler/icons/outline/player-play.svg";
import refreshIcon from "@tabler/icons/outline/refresh.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import updateIcon from "@tabler/icons/outline/arrow-up-circle.svg";

const KIND_LABEL = { npx: "npm", uvx: "uv", binary: "binary" };

function AgentCard({ agent: a }: { agent: CatalogAgent }) {
  const { t } = useL10n();
  return (
    <div className={"catalog-card" + (a.active ? " active" : "")}>
      <div className="catalog-tile">
        <div className="catalog-icon" style={a.icon ? { maskImage: `url("${a.icon}")` } : undefined} />
      </div>
      <div className="catalog-body">
        <div className="catalog-title">
          <span className="catalog-name">{a.name}</span>
          <span className="catalog-version">{a.version}</span>
          {a.kind && <span className="catalog-badge">{KIND_LABEL[a.kind]}</span>}
          {a.active && <span className="catalog-badge active">{t("manager.active")}</span>}
        </div>
        <div className="catalog-desc">{a.description}</div>
        <div className="catalog-meta">
          {a.license && (
            <span className="catalog-meta-item">
              <Icon svg={licenseIcon} />
              {a.license}
            </span>
          )}
          {a.url && (
            <a
              className="catalog-meta-item"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                post({ type: "catalogOpen", url: a.url! });
              }}
            >
              <Icon svg={externalLinkIcon} />
              <span className="catalog-link">{a.url.replace(/^https:\/\//, "")}</span>
            </a>
          )}
        </div>
      </div>
      <div className="catalog-actions">
        {a.busy ? (
          <span className="catalog-status busy">
            <Icon svg={loaderIcon} />
            {a.busy}
          </span>
        ) : !a.kind ? (
          <span className="catalog-status">{t("manager.unsupported")}</span>
        ) : a.installedVersion ? (
          <>
            {!a.active && (
              <button className="with-icon" onClick={() => post({ type: "use", id: a.id })}>
                <Icon svg={playIcon} />
                {t("manager.use")}
              </button>
            )}
            {a.installedVersion !== a.version && (
              <button className="secondary with-icon" onClick={() => post({ type: "catalogInstall", id: a.id })}>
                <Icon svg={updateIcon} />
                {t("manager.update", a.installedVersion, a.version)}
              </button>
            )}
            <button
              className="icon-btn danger"
              title={t("manager.uninstall")}
              aria-label={t("manager.uninstall")}
              onClick={() => post({ type: "catalogUninstall", id: a.id })}
            >
              <Icon svg={trashIcon} />
            </button>
          </>
        ) : (
          <button className="with-icon" onClick={() => post({ type: "catalogInstall", id: a.id })}>
            <Icon svg={downloadIcon} />
            {t("manager.install")}
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentCatalogTab({ catalog }: { catalog: CatalogState }) {
  const { t } = useL10n();
  const [query, setQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);

  const q = query.trim().toLowerCase();
  const agents = catalog.agents
    .filter((a) => !installedOnly || a.installedVersion)
    .filter((a) => !q || `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q))
    // Installed agents first, then by name.
    .sort((x, y) => Number(!!y.installedVersion) - Number(!!x.installedVersion) || x.name.localeCompare(y.name));

  return (
    <>
      <div className="catalog-toolbar">
        <div className="catalog-search">
          <Icon svg={searchIcon} />
          <input
            type="search"
            aria-label={t("manager.search")}
            placeholder={t("manager.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="catalog-filter">
          <input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} />
          <span>{t("manager.installedOnly")}</span>
        </label>
        <span className="catalog-count">{t("manager.count", agents.length)}</span>
        <button
          className={"secondary with-icon catalog-refresh" + (catalog.loading ? " loading" : "")}
          disabled={catalog.loading}
          onClick={() => post({ type: "catalogRefresh" })}
        >
          <Icon svg={refreshIcon} />
          {catalog.loading ? t("manager.loading") : t("manager.refresh")}
        </button>
      </div>
      {catalog.error && (
        <div className="catalog-error" role="alert">
          {catalog.error}
        </div>
      )}
      <div className="catalog-list">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
        {!agents.length && !catalog.loading && (
          <div className="catalog-empty">
            <Icon svg={packageIcon} />
            <span>{t("manager.empty")}</span>
          </div>
        )}
      </div>
    </>
  );
}
