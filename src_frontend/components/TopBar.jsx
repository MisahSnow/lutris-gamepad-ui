import { useState, useEffect } from "react";

import packageJson from "../../package.json";
import { useStaticSettings } from "../hooks/useStaticSettings";
import { useAudio } from "../stores/audioStore";
import { useInput } from "../stores/inputStore";
import { useTranslation } from "../stores/translationStore";
import "../styles/TopBar.css";

const AudioIndicator = () => {
  const { t } = useTranslation();
  const { volume, isMuted, isLoading: audioIsLoading } = useAudio();

  if (audioIsLoading) return null;

  return (
    <span className="top-bar-pill">
      <span className="top-bar-label">VOL</span>
      <span className="top-bar-value">
        {isMuted ? t("Muted") : `${volume}%`}
      </span>
    </span>
  );
};

const TopBar = () => {
  const { t } = useTranslation();
  const { gamepadCount } = useInput();
  const { staticSettings } = useStaticSettings();

  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [time, setTime] = useState(() => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  });

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      setTime(`${hours}:${minutes}`);
    };

    const timerId = setInterval(updateClock, 1000);

    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
    };

    globalThis.addEventListener("online", updateOnlineStatus);
    globalThis.addEventListener("offline", updateOnlineStatus);

    return () => {
      clearInterval(timerId);
      globalThis.removeEventListener("online", updateOnlineStatus);
      globalThis.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  const getNetworkIndicator = () => {
    return isOnline ? "Online" : t("Offline");
  };

  const isAudioDisabled = staticSettings.DISABLE_AUDIO_SETTINGS;

  return (
    <div className="top-bar">
      <div className="top-bar-content">
        <span className="top-bar-pill top-bar-time">
          <span className="top-bar-value">{time}</span>
        </span>
        <span className="top-bar-pill">
          <span className="top-bar-label">PAD</span>
          <span className="top-bar-value">
            {gamepadCount > 0 ? gamepadCount : "N/A"}
          </span>
        </span>
        {!isAudioDisabled && <AudioIndicator />}
        <span
          className={`top-bar-pill top-bar-network ${
            isOnline ? "online" : "offline"
          }`}
        >
          <span className="top-bar-status-dot" />
          <span className="top-bar-value">{getNetworkIndicator()}</span>
        </span>
        <span className="top-bar-version">v{packageJson.version}</span>
      </div>
    </div>
  );
};

export default TopBar;
