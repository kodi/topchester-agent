/** @jsxImportSource @opentui/solid */

import { createComponent, createContext, useContext, type Accessor, type ParentProps } from "solid-js";
import { type TopchesterTuiController } from "../../chat/controller.js";
import { type TuiViewState } from "../../chat/controller-state.js";
import { type TopchesterTheme } from "./theme.js";

export interface ControllerContextValue {
  controller: TopchesterTuiController;
  snapshot: Accessor<TuiViewState>;
}

const ControllerContext = createContext<ControllerContextValue>();
const ThemeContext = createContext<TopchesterTheme>();

export function ControllerProvider(props: ParentProps<ControllerContextValue>) {
  const value: ControllerContextValue = { controller: props.controller, snapshot: props.snapshot };
  return createComponent(ControllerContext.Provider, {
    value,
    get children() {
      return props.children;
    },
  });
}

export function ThemeProvider(props: ParentProps<{ theme: TopchesterTheme }>) {
  return createComponent(ThemeContext.Provider, {
    get value() {
      return props.theme;
    },
    get children() {
      return props.children;
    },
  });
}

export function useController(): ControllerContextValue {
  const value = useContext(ControllerContext);
  if (!value) {
    throw new Error("OpenTUI controller context is missing");
  }
  return value;
}

export function useTheme(): TopchesterTheme {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("OpenTUI theme context is missing");
  }
  return value;
}
