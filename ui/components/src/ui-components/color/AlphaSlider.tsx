/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Color */

import * as React from "react";
import "./AlphaSlider.scss";
import classnames from "classnames";

/** Properties for the [[AlphaSlider]] React component */
export interface AlphaSliderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** true if slider is oriented horizontal, else vertical orientation is assumed */
  isHorizontal?: boolean;
  /** function to run when user selects color swatch */
  onAlphaChange?: ((alpha: number) => void) | undefined;
  /** Alpha value between 0 (transparent) and 1 (opaque) */
  alpha: number;
}

/** AlphaSlider component used to set the alpha value. */
export class AlphaSlider extends React.PureComponent<AlphaSliderProps> {
  private _container: HTMLDivElement | null = null;

  constructor(props: AlphaSliderProps) {
    super(props);
  }

  private _calculateChange = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>, isHorizontal: boolean, alpha: number, container: HTMLDivElement): number | undefined => {
    e.preventDefault();
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    let x = 0;
    if ("pageX" in e) {
      x = (e as React.MouseEvent<HTMLDivElement>).pageX;
    } else {
      if (undefined === e.touches)
        return undefined;
      x = (e as React.TouchEvent<HTMLDivElement>).touches[0].pageX;
    }
    if (undefined === x)
      return undefined;

    let y = 0;
    if ("pageY" in e) {
      y = (e as React.MouseEvent<HTMLDivElement>).pageY;
    } else {
      if (undefined === e.touches)
        return;
      y = (e as React.TouchEvent<HTMLDivElement>).touches[0].pageY;
    }
    if (undefined === y)
      return undefined;

    const left = x - (container.getBoundingClientRect().left + window.pageXOffset);
    const top = y - (container.getBoundingClientRect().top + window.pageYOffset);

    let t = alpha;

    if (!isHorizontal) {
      if (top < 0) {
        t = 1;
      } else if (top > containerHeight) {
        t = 0;
      } else {
        t = 1 - (top / containerHeight);
      }
    } else {  // horizontal
      if (left < 0) {
        t = 0;
      } else if (left > containerWidth) {
        t = 1;
      } else {
        t = left / containerWidth;
      }
    }

    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return (alpha !== t) ? t : undefined;
  }

  public componentWillUnmount() {
    this._unbindEventListeners();
  }

  private _onChange = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (this._container && this.props.onAlphaChange) {
      const change = this._calculateChange(e, this.props.isHorizontal ? this.props.isHorizontal : false, this.props.alpha, this._container);
      undefined !== change && typeof this.props.onAlphaChange === "function" && this.props.onAlphaChange(change);
    }
  }

  private _onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    this._onChange(e);
    if (this._container)
      this._container.focus();
    window.addEventListener("mousemove", this._onChange as any);
    window.addEventListener("mouseup", this._onMouseUp);
  }

  private _onKeyDown = (evt: React.KeyboardEvent<HTMLDivElement>) => {
    let newTransparency: number | undefined;
    if (evt.key === "ArrowLeft" || evt.key === "ArrowDown") {
      newTransparency = this.props.alpha - (evt.ctrlKey ? .1 : .05);
    } else if (evt.key === "ArrowRight" || evt.key === "ArrowUp") {
      newTransparency = this.props.alpha + (evt.ctrlKey ? .1 : .05);
    } else if (evt.key === "PageDown") {
      newTransparency = this.props.alpha - (evt.ctrlKey ? .5 : .25);
    } else if (evt.key === "PageUp") {
      newTransparency = this.props.alpha + (evt.ctrlKey ? .5 : .25);
    } else if (evt.key === "Home") {
      newTransparency = 0;
    } else if (evt.key === "End") {
      newTransparency = 1;
    }

    if (undefined !== newTransparency) {
      if (newTransparency > 1) newTransparency = 1;
      if (newTransparency < 0) newTransparency = 0;
      if (this.props.onAlphaChange)
        this.props.onAlphaChange(newTransparency);
    }
  }

  private _onMouseUp = () => {
    this._unbindEventListeners();
  }

  private _unbindEventListeners() {
    window.removeEventListener("mousemove", this._onChange as any);
    window.removeEventListener("mouseup", this._onMouseUp);
  }

  public render(): React.ReactNode {
    const containerClasses = classnames(
      this.props.isHorizontal ? "components-alpha-container-horizontal" : "components-alpha-container-vertical",
    );

    const pointerStyle: React.CSSProperties = this.props.isHorizontal ? {
      left: `${(this.props.alpha * 100)}%`,
    } : {
        left: `0px`,
        top: `${-(this.props.alpha * 100) + 100}%`,
      };

    return (
      <div className={containerClasses} data-testid="alpha-container">
        <div
          data-testid="alpha-slider"
          role="slider" aria-label="Transparency"
          aria-valuemin={0} aria-valuemax={1} aria-valuenow={this.props.alpha}
          className="components-alpha-slider"
          ref={(container) => this._container = container}
          onMouseDown={this._onMouseDown}
          onTouchMove={this._onChange}
          onTouchStart={this._onChange}
          tabIndex={0}
          onKeyDown={this._onKeyDown}
        >
          <div style={pointerStyle} className="components-alpha-pointer" data-testid="alpha-pointer" />
        </div>
      </div>
    );
  }

}
