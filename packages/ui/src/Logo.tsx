import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

/** The SGM flame, drawn on a 1024 square. The app icons are made from the same shapes. */
const OUTER =
  'M512 152 C530 230 610 300 680 380 C740 450 776 520 776 610 C776 760 660 876 512 876 C364 876 246 760 246 610 C246 520 290 450 358 378 C370 460 400 515 460 535 C430 420 440 280 512 152 Z';
const INNER =
  'M512 520 C535 590 634 640 634 735 C634 803 580 858 512 858 C444 858 390 803 390 735 C390 680 420 645 456 610 C465 650 485 680 510 688 C495 630 492 575 512 520 Z';

/** Light tile colours that keep the blue flame clear on the dark sidebar and on light screens alike. */
export const LOGO_COLORS = { tileTop: '#F7FAFF', tileBottom: '#DCE8FF', flameTop: '#38B6FF', flameBottom: '#1747C6', core: '#EAF6FF' };

/** The blue flame on its light tile, as on the app icons. */
export function Logo({ size = 36 }: { size?: number }) {
  const c = LOGO_COLORS;
  return (
    <View
      style={{ width: size, height: size, borderRadius: size * 0.22, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(23, 71, 198, 0.18)' }}
      accessibilityLabel="SGM"
    >
      <Svg width={size} height={size} viewBox="0 0 1024 1024">
        <Defs>
          <LinearGradient id="sgm-tile" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.tileTop} />
            <Stop offset="1" stopColor={c.tileBottom} />
          </LinearGradient>
          <LinearGradient id="sgm-flame" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.flameTop} />
            <Stop offset="1" stopColor={c.flameBottom} />
          </LinearGradient>
        </Defs>
        <Path d="M0 0 H1024 V1024 H0 Z" fill="url(#sgm-tile)" />
        <Path d={OUTER} fill="url(#sgm-flame)" transform="translate(512 514) scale(1.12) translate(-512 -514)" />
        <Path d={INNER} fill={c.core} transform="translate(512 514) scale(1.12) translate(-512 -514)" />
      </Svg>
    </View>
  );
}
