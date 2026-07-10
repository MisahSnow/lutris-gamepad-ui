import React from "react";

import "../styles/GameCard.css";
import { useVisibilityObserver } from "../hooks/useVisibilityObserver";
import { useSettingsState } from "../stores/settingsStore";
import { useTranslation } from "../stores/translationStore";
import { formatDate } from "../utils/datetime";
import { encodeAppProtocolPath } from "../utils/ipc";

import GameCover from "./GameCover";

const GameCard = React.forwardRef(
  ({ game, onFocus, onClick, isFocused }, reference) => {
    const { t } = useTranslation();
    const { settings } = useSettingsState();

    const { isVisible, setRef } = useVisibilityObserver({
      externalRef: reference,
      rootMargin: "20%",
    });

    const shouldRenderMedia = isVisible || isFocused;

    const shouldShowRunnerIcon =
      shouldRenderMedia && settings.showRunnerIcon && game.runtimeIconPath;

    const className = isFocused ? "game-card focused" : "game-card";

    return (
      <article
        ref={setRef}
        className={className}
        data-has-runner-icon={shouldShowRunnerIcon ? "true" : undefined}
        aria-label={game.title}
        tabIndex="-1"
        onClick={onClick}
        onMouseEnter={onFocus}
      >
        <div className="game-card-artwork">
          {shouldRenderMedia ? (
            game.coverPath ? (
              <img
                src={encodeAppProtocolPath(game.coverPath)}
                alt={game.title}
                className="game-card-cover"
                decoding="async"
                loading="lazy"
              />
            ) : (
              <GameCover game={game} className="game-card-cover" />
            )
          ) : (
            <div className="game-card-cover placeholder" />
          )}

          {shouldShowRunnerIcon && (
            <img
              src={encodeAppProtocolPath(game.runtimeIconPath)}
              alt=""
              className="game-card-runner-icon"
              decoding="async"
              loading="lazy"
            />
          )}

          <div className="game-card-overlay">
            <span className="game-card-action">{t("Play")}</span>
          </div>
        </div>

        <div className="game-card-info">
          <h3 className="game-card-title">{game.title}</h3>
          <p>
            {game.runner ||
              t("Last played: {{date}}", {
                date: formatDate(game.lastPlayed) || t("Never"),
              })}
          </p>
        </div>
      </article>
    );
  },
);

GameCard.displayName = "GameCard";

export default React.memo(GameCard);
