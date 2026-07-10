import LegendaContainer from "./LegendaContainer";
import "../styles/DialogLayout.css";

const DialogLayout = ({
  title,
  description,
  children,
  legendItems = [],
  className = "",
  contentClassName = "",
  containerRef,
  contentRef,
  style = {},
  scrollable = true,
}) => {
  return (
    <div
      className={`dialog-layout-container ${className}`}
      style={style}
      ref={containerRef}
    >
      <LegendaContainer
        legendItems={legendItems}
        ref={contentRef}
        scrollable={scrollable}
      >
        <div className={`dialog-layout-content ${contentClassName}`}>
          {(title || description) && (
            <header className="dialog-layout-header">
              <span className="dialog-layout-header-mark" />
              {title && <h2 className="dialog-layout-title">{title}</h2>}
              {description && (
                <p className="dialog-layout-description">{description}</p>
              )}
            </header>
          )}
          {children}
        </div>
      </LegendaContainer>
    </div>
  );
};

export default DialogLayout;
