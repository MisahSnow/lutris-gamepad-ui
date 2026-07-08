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
import { toggleWindowShow, toggleGamePause } from "../utils/ipc";

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
  const scrollParentReference = useRef(null);

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

  useGlobalShortcut([
    {
      key: "Super",
      active: true,
      action: useCallback(() => {
        playActionSound();
        toggleWindowShow();
      }, [playActionSound]),
    },
  ]);

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

  const renderHeader = useCallback(
    () => {
      if (searchQuery) {
        return (
          <header className="library-header">
            <h1>{t("Search")}</h1>
          </header>
        );
      }

      return (
        <header className="library-header">
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
        </header>
      );
    },
    [
      normalizedActiveShelfIndex,
      searchQuery,
      selectShelfCallback,
      shelves,
      t,
    ],
  );

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
        scrollParentRef={scrollParentReference}
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
      controlsOverlayProperties.onNextCategory = () =>
        navigateShelfCallback(1);
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
      scrollParentRef={scrollParentReference}
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
        scrollParentRef={scrollParentReference}
      />
    </ControlsOverlay>
  );
};

export default LibraryContainer;
