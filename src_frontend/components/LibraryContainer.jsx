import { useState, useCallback, useMemo, useRef, useEffect } from "react";

import { useGameShelves } from "../hooks/useGameShelves";
import { useGlobalShortcut } from "../hooks/useGlobalShortcut";
import { usePlayButtonActionSound } from "../hooks/usePlayButtonActionSound";
import { useScopedInput } from "../hooks/useScopedInput";
import GridMenu from "../navigation/grid_menu/GridMenu";
import { useLutris, useLutrisActions } from "../stores/lutrisStore";
import { useModalActions, useModalState } from "../stores/modalStore";
import { useTranslation } from "../stores/translationStore";
import { useUI } from "../stores/uiStore";
import { formatDate, formatPlaytime } from "../utils/datetime";
import {
  encodeAppProtocolPath,
  getGameHeroImage,
  logWarn,
  toggleGamePause,
} from "../utils/ipc";

import ConfirmationDialog from "./ConfirmationDialog";
import ControlsOverlay from "./ControlsOverlay";
import GameCard from "./GameCard";
import LoadingIndicator from "./LoadingIndicator";
import LutrisSettingsMenu from "./LutrisSettingsMenu";
import OnScreenKeyboard from "./OnScreenKeyboard";
import RunningAppsMenu from "./RunningAppsMenu";
import RunningGame from "./RunningGame";

export const LibraryContainerFocusID = "LibraryContainer";

const LibraryContainer = () => {
  const { t } = useTranslation();
  const { games, loading, runningGame, isGamePaused } = useLutris();
  const { launchGame, closeRunningGame } = useLutrisActions();
  const { showModal } = useModalActions();
  const { isModalOpen } = useModalState();
  const { isSystemMenuOpen, toggleSystemMenu } = useUI();
  const playActionSound = usePlayButtonActionSound();

  const [searchQuery, setSearchQuery] = useState("");
  const gameCloseModalReference = useRef(null);
  const contentReference = useRef(null);
  const libraryScrollReference = useRef(null);

  const { shelves } = useGameShelves(games, searchQuery);
  const [activeShelfIndex, setActiveShelfIndex] = useState(0);
  const normalizedActiveShelfIndex =
    shelves.length > 0 ? activeShelfIndex % shelves.length : 0;
  const activeShelf = shelves[normalizedActiveShelfIndex] || null;

  const sections = useMemo(
    () => [
      {
        id: activeShelf?.id || "library",
        items: activeShelf?.games || [],
      },
    ],
    [activeShelf],
  );

  useEffect(() => {
    if (!runningGame && gameCloseModalReference.current) {
      gameCloseModalReference.current();
      gameCloseModalReference.current = null;
    }
  }, [runningGame]);

  const [focusedGame, setFocusedGame] = useState(null);
  const featuredGame = focusedGame || activeShelf?.games?.[0] || null;
  const featuredGameId = featuredGame?.id;
  const [heroImagePaths, setHeroImagePaths] = useState(() => new Map());
  const heroImagePath = heroImagePaths.get(featuredGameId) || null;

  useEffect(() => {
    if (
      featuredGameId === null ||
      featuredGameId === undefined ||
      heroImagePaths.has(featuredGameId)
    ) {
      return;
    }

    let isActive = true;

    const timeoutId = setTimeout(() => {
      getGameHeroImage(featuredGameId)
        .then((imagePath) => {
          if (isActive) {
            setHeroImagePaths((currentPaths) => {
              const nextPaths = new Map(currentPaths);
              nextPaths.set(featuredGameId, imagePath || null);
              return nextPaths;
            });
          }
        })
        .catch((error) => logWarn("Unable to load hero image", error));
    }, 300);

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [featuredGameId, heroImagePaths]);

  const showSearchModalCallback = useCallback(() => {
    showModal((hideThisModal) => (
      <OnScreenKeyboard
        label={t("Search Library")}
        initialValue={searchQuery}
        onConfirm={(query) => {
          setActiveShelfIndex(0);
          setSearchQuery(query);
          hideThisModal();
        }}
        onClose={hideThisModal}
      />
    ));
  }, [setSearchQuery, showModal, searchQuery, t]);

  const showGameSettingsModalCallback = useCallback(
    (game) => {
      if (game) {
        showModal((hideThisModal) => (
          <LutrisSettingsMenu
            gameIdentifier={game.id}
            runnerSlug={game.runner}
            onClose={hideThisModal}
          />
        ));
      }
    },
    [showModal],
  );

  const clearSearchCallback = useCallback(() => {
    setActiveShelfIndex(0);
    setSearchQuery("");
  }, [setSearchQuery]);

  const toggleGamePauseCallback = useCallback(() => {
    if (!runningGame) return;

    if (gameCloseModalReference.current) {
      gameCloseModalReference.current();
      gameCloseModalReference.current = null;
    }

    if (isGamePaused) {
      toggleGamePause();
    } else {
      showModal((hideThisModal) => {
        gameCloseModalReference.current = hideThisModal;
        return (
          <ConfirmationDialog
            message={t("Are you sure you want to pause\n{{title}}?", {
              title: runningGame.title,
            })}
            description={t(
              "This feature is experimental. Pausing the game may cause issues.",
            )}
            onConfirm={() => {
              toggleGamePause();
              hideThisModal();
            }}
            onDeny={hideThisModal}
          />
        );
      });
    }
  }, [runningGame, isGamePaused, t, showModal]);

  const closeRunningGameDialogCallback = useCallback(() => {
    if (!runningGame) return;

    if (gameCloseModalReference.current) {
      gameCloseModalReference.current();
    }

    showModal((hideThisModal) => {
      gameCloseModalReference.current = hideThisModal;
      return (
        <ConfirmationDialog
          message={t("Are you sure you want to close\n{{title}}?", {
            title: runningGame.title,
          })}
          description={t(
            "This action will force-quit the game. Any unsaved progress may be lost.",
          )}
          onConfirm={() => {
            closeRunningGame();
            hideThisModal();
          }}
          onDeny={hideThisModal}
        />
      );
    });
  }, [closeRunningGame, showModal, runningGame, t]);

  const handleAction = useCallback(
    (actionName, game) => {
      switch (actionName) {
        case "A": {
          if (game) {
            playActionSound();
            launchGame(game);
          }
          break;
        }
        case "B": {
          if (searchQuery) {
            playActionSound();
            clearSearchCallback();
          }
          break;
        }
        case "X": {
          playActionSound();
          showSearchModalCallback();
          break;
        }
        case "Start": {
          playActionSound();
          showGameSettingsModalCallback(game);
          break;
        }
      }
    },
    [
      searchQuery,
      launchGame,
      clearSearchCallback,
      showSearchModalCallback,
      showGameSettingsModalCallback,
      playActionSound,
    ],
  );

  const handleRunningGameAction = useCallback(
    (input) => {
      if (input.name === "B") {
        playActionSound();
        closeRunningGameDialogCallback();
      }
      if (input.name === "X") {
        playActionSound();
        toggleGamePauseCallback();
      }
    },
    [closeRunningGameDialogCallback, toggleGamePauseCallback, playActionSound],
  );

  useScopedInput(
    handleRunningGameAction,
    LibraryContainerFocusID,
    !!runningGame && !isModalOpen,
  );

  const openSystemMenu = useCallback(() => {
    toggleSystemMenu();
  }, [toggleSystemMenu]);

  const openRunningAppsMenu = useCallback(() => {
    showModal((hideThisModal) => <RunningAppsMenu onClose={hideThisModal} />);
  }, [showModal]);

  const navigateShelfCallback = useCallback(
    (delta) => {
      if (shelves.length <= 1) {
        return;
      }

      playActionSound();
      setActiveShelfIndex((currentIndex) => {
        return (currentIndex + delta + shelves.length) % shelves.length;
      });
    },
    [playActionSound, shelves.length],
  );

  const selectShelfCallback = useCallback(
    (shelfIndex) => {
      if (shelfIndex === normalizedActiveShelfIndex) {
        return;
      }

      playActionSound();
      setActiveShelfIndex(shelfIndex);
    },
    [normalizedActiveShelfIndex, playActionSound],
  );

  useGlobalShortcut([
    {
      key: "Select",
      active: !isModalOpen && !isSystemMenuOpen,
      action: useCallback(() => {
        playActionSound();
        openRunningAppsMenu();
      }, [openRunningAppsMenu, playActionSound]),
    },
  ]);

  const renderItem = useCallback(
    (game, { isFocused }, { onFocus, onClick, ref }) => (
      <GameCard
        ref={ref}
        game={game}
        isFocused={isFocused}
        onFocus={onFocus}
        onClick={onClick}
      />
    ),
    [],
  );

  const renderHeader = useCallback(() => {
    const backgroundPath = heroImagePath || featuredGame?.coverPath;
    const backgroundStyle = backgroundPath
      ? {
          backgroundImage: `url("${encodeAppProtocolPath(backgroundPath)}")`,
        }
      : undefined;

    return (
      <header className="library-hero">
        <div className="library-hero-art" style={backgroundStyle} />
        <div className="library-hero-vignette" />

        <div className="library-hero-layout">
          <nav className="library-tabs" aria-label="Library categories">
            {shelves.map((shelf, shelfIndex) => {
              const isActive = shelfIndex === normalizedActiveShelfIndex;

              return (
                <button
                  key={shelf.id || shelf.title}
                  type="button"
                  className={`library-tab ${isActive ? "active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => selectShelfCallback(shelfIndex)}
                >
                  {shelf.title}
                </button>
              );
            })}
          </nav>

          <div className="library-hero-copy">
            <div className="library-hero-eyebrow">
              <span>{searchQuery ? t("Search") : activeShelf?.title}</span>
              <span className="library-hero-count">
                {activeShelf?.games?.length || 0}
              </span>
            </div>
            <h1>{featuredGame?.title || t("Your Library")}</h1>
            {featuredGame && (
              <div className="library-hero-meta">
                {featuredGame.runner && <span>{featuredGame.runner}</span>}
                <span>
                  {t("Playtime: {{playtime}}", {
                    playtime: formatPlaytime(featuredGame.playtimeSeconds),
                  })}
                </span>
                <span>
                  {t("Last played: {{date}}", {
                    date: formatDate(featuredGame.lastPlayed) || t("Never"),
                  })}
                </span>
              </div>
            )}
            <div className="library-hero-rule" />
          </div>
        </div>
      </header>
    );
  }, [
    activeShelf,
    featuredGame,
    heroImagePath,
    normalizedActiveShelfIndex,
    searchQuery,
    selectShelfCallback,
    shelves,
    t,
  ]);

  const renderEmpty = useCallback(
    () => (
      <div className="empty-library-message">
        <h2>
          {searchQuery
            ? t('No results for "{{searchQuery}}"', { searchQuery })
            : t("No games found")}
        </h2>
        <p>
          {searchQuery
            ? t("Try a different search term or press 'B' to clear.")
            : t("Add games in Lutris and reload.")}
        </p>
      </div>
    ),
    [searchQuery, t],
  );

  if (loading) {
    return <LoadingIndicator message={t("Loading library...")} />;
  }

  const controlsOverlayProperties = {
    onOpenSystemMenu: openSystemMenu,
    onOpenRunningAppsMenu: openRunningAppsMenu,
  };

  if (runningGame) {
    controlsOverlayProperties.onCloseRunningGame =
      closeRunningGameDialogCallback;
    controlsOverlayProperties.onToggleGamePause = toggleGamePauseCallback;
    controlsOverlayProperties.isGamePaused = isGamePaused;

    return (
      <ControlsOverlay
        {...controlsOverlayProperties}
        scrollParentRef={contentReference}
      >
        <RunningGame
          game={runningGame}
          isPaused={isGamePaused}
          onAction={handleRunningGameAction}
        />
      </ControlsOverlay>
    );
  }

  if (!isModalOpen) {
    if (shelves.length > 1) {
      controlsOverlayProperties.onPrevCategory = () =>
        navigateShelfCallback(-1);
      controlsOverlayProperties.onNextCategory = () => navigateShelfCallback(1);
    }
    if (focusedGame) {
      controlsOverlayProperties.onLaunchGame = () => launchGame(focusedGame);
      controlsOverlayProperties.onShowGameSettings = () =>
        showGameSettingsModalCallback(focusedGame);
    }
    if (searchQuery) {
      controlsOverlayProperties.onClearSearch = clearSearchCallback;
    }
    controlsOverlayProperties.onShowSearchModal = showSearchModalCallback;
  }

  return (
    <ControlsOverlay
      {...controlsOverlayProperties}
      scrollParentRef={contentReference}
    >
      <GridMenu
        sections={sections}
        renderItem={renderItem}
        renderHeader={renderHeader}
        renderEmpty={renderEmpty}
        onAction={handleAction}
        onSectionNavigate={navigateShelfCallback}
        onFocusChange={setFocusedGame}
        focusId={LibraryContainerFocusID}
        isActive={!runningGame && !isModalOpen}
        scrollParentRef={libraryScrollReference}
      />
    </ControlsOverlay>
  );
};

export default LibraryContainer;
