/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module WireFormats */

import { ElementProps, RelatedElementProps } from "../ElementProps";

/** @public */
export interface FunctionalElementProps extends ElementProps {
  typeDefinition?: RelatedElementProps;
}
