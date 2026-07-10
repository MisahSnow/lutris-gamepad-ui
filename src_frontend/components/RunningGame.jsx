import "../styles/RunningGame.css";
import { useTranslation } from "../stores/translationStore";
import { getDeterministicGradient } from "../utils/color";
import { formatPlaytime } from "../utils/datetime";
import { encodeAppProtocolPath } from "../utils/ipc";

import GameCover from "./GameCover";

const RunningGamePage = ({ game, isPaused }) => {
  const { t } = useTranslation();
  if (!game) return null;

  const gradient = getDeterministicGradient(game.title);

  const backgroundStyle = {
    backgroundImage: game.coverPath
      ? `linear-gradient(90deg, rgba(var(--rp-base-rgb), 0.97) 0%, rgba(var(--rp-base-rgb), 0.78) 42%, rgba(var(--rp-base-rgb), 0.18) 100%), url("${encodeAppProtocolPath(
          game.coverPath,
        )}")`
      : `radial-gradient(circle at 75% 35%, ${gradient.start} 0%, ${gradient.end} 70%)`,
  };

  return (
    <div className="running-game-page">
      <div className="running-game-background" style={backgroundStyle} />
      <div className="running-game-content">
        <div className="running-game-info">
          <div className="running-game-status">
            <span className="running-game-status-dot" />
            {isPaused ? t("Paused") : t("Now Playing")}
          </div>
          <h1>{game.title}</h1>
          <p>
            {t("Playtime: {{playtime}}", {
              playtime: formatPlaytime(game.playtimeSeconds),
            })}
          </p>
          <div className="running-game-rule" />
          <p className="running-game-session-copy">
            {isPaused ? t("Game session suspended") : t("Game session active")}
          </p>
        </div>
        <div className="running-game-cover-container">
          {game.coverPath ? (
            <img
              src={encodeAppProtocolPath(game.coverPath)}
              alt={game.title}
              className="running-game-cover"
              decoding="async"
              loading="lazy"
            />
          ) : (
            <GameCover game={game} className="running-game-cover" />
          )}
        </div>
      </div>
    </div>
  );
};

export default RunningGamePage;
