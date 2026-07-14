import { useState, useEffect } from "react";

import packageJson from "../../package.json";
import { useStaticSettings } from "../hooks/useStaticSettings";
import { useAudio } from "../stores/audioStore";
import { useInput } from "../stores/inputStore";
import { useTranslation } from "../stores/translationStore";
import "../styles/TopBar.css";

const BrandMark = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 2 30 16 16 30 2 16 16 2Z" />
    <path d="m16 8 8 8-8 8-8-8 8-8Z" />
  </svg>
);

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

const formatClockTime = (date) => {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${minutes} ${period}`;
};

const TopBar = () => {
  const { t } = useTranslation();
  const { gamepadCount } = useInput();
  const { staticSettings } = useStaticSettings();

  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [time, setTime] = useState(() => formatClockTime(new Date()));

  useEffect(() => {
    const updateClock = () => {
      setTime(formatClockTime(new Date()));
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
        <div className="top-bar-brand">
          <span className="top-bar-brand-mark">
            <BrandMark />
          </span>
          <span className="top-bar-brand-copy">
            <strong>LUTRIS</strong>
            <small>BIGSCREEN</small>
          </span>
        </div>

        <div className="top-bar-status">
          <span
            className={`top-bar-pill top-bar-network ${
              isOnline ? "online" : "offline"
            }`}
          >
            <span className="top-bar-status-dot" />
            <span className="top-bar-value">{getNetworkIndicator()}</span>
          </span>
          <span className="top-bar-pill">
            <span className="top-bar-label">PAD</span>
            <span className="top-bar-value">
              {gamepadCount > 0 ? gamepadCount : "—"}
            </span>
          </span>
          {!isAudioDisabled && <AudioIndicator />}
          <span className="top-bar-version">v{packageJson.version}</span>
          <span className="top-bar-time">{time}</span>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
