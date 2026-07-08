import { useCallback, useEffect, useState } from "react";

import RowBasedMenu from "../navigation/row_based_menu/RowBasedMenu";
import { useToastActions } from "../stores/toastStore";
import { useTranslation } from "../stores/translationStore";
import {
  closeRunningUserApp,
  encodeAppProtocolPath,
  focusRunningUserApp,
  listRunningUserApps,
} from "../utils/ipc";

import DialogLayout from "./DialogLayout";
import FocusableRow from "./FocusableRow";

import "../styles/RunningAppsMenu.css";

const RunningAppsMenu = ({ onClose }) => {
  const { t } = useTranslation();
  const { showToast } = useToastActions();
  const [apps, setApps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshApps = useCallback(async () => {
    setIsLoading(true);
    try {
      setApps(await listRunningUserApps());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(refreshApps, 0);
    return () => clearTimeout(timeout);
  }, [refreshApps]);

  const closeApp = useCallback(
    async (app) => {
      if (!app) {
        return;
      }

      await closeRunningUserApp(app.pid, app.windowAddress);
      showToast({
        title: t("Close requested"),
        description: app.name,
        type: "info",
      });
      await refreshApps();
    },
    [refreshApps, showToast, t],
  );

  const focusApp = useCallback(
    (app) => {
      if (!app) {
        return;
      }

      return focusRunningUserApp(app.pid, app.windowAddress)
        .then(onClose)
        .catch(() => {
          // The IPC handler already logs and shows the focus error.
        });
    },
    [onClose],
  );

  const handleAction = useCallback(
    (actionName, app) => {
      switch (actionName) {
        case "A": {
          void focusApp(app);
          break;
        }
        case "B": {
          onClose();
          break;
        }
        case "X": {
          void closeApp(app).catch(() => {
            // The IPC handler already logs and shows the close error.
          });
          break;
        }
        case "Y": {
          void refreshApps();
          break;
        }
      }
    },
    [closeApp, focusApp, onClose, refreshApps],
  );

  const renderItem = useCallback(
    (app, isFocused, onMouseEnter, ref) => (
      <FocusableRow
        ref={ref}
        isFocused={isFocused}
        onMouseEnter={onMouseEnter}
        onClick={() => {
          void focusApp(app);
        }}
      >
        <div className="running-app-row">
          {app.iconPath ? (
            <img
              className="running-app-icon"
              src={encodeAppProtocolPath(app.iconPath)}
              alt=""
              decoding="async"
              loading="lazy"
            />
          ) : (
            <div className="running-app-icon running-app-icon-fallback" />
          )}
          <div className="running-app-content">
            <div className="running-app-name">{app.name}</div>
          </div>
        </div>
      </FocusableRow>
    ),
    [focusApp],
  );

  const legendItems = [
    { button: "A", label: t("Focus") },
    { button: "X", label: t("Close") },
    { button: "Y", label: t("Refresh"), onClick: refreshApps },
    { button: "B", label: t("Back"), onClick: onClose },
  ];

  return (
    <DialogLayout
      title={t("Running Apps")}
      description={isLoading ? t("Loading...") : undefined}
      legendItems={legendItems}
      className="wide"
      scrollable={false}
    >
      <RowBasedMenu
        items={apps}
        renderItem={renderItem}
        onAction={handleAction}
        focusId="RunningAppsMenu"
        itemKey={(app) => app.pid}
        emptyMessage={isLoading ? "" : t("No running user apps found.")}
      />
    </DialogLayout>
  );
};

export default RunningAppsMenu;
