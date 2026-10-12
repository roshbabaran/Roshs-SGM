import { useWindowDimensions } from 'react-native';

/** Screen-size helpers so one screen can lay out for a phone or a PC. */
export function useBreakpoint() {
  const { width } = useWindowDimensions();
  return { width, isPhone: width < 640, isWide: width >= 1000 };
}
