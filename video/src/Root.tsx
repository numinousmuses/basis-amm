import { Composition } from "remotion";
import { BasisDemo, TOTAL, type DemoProps } from "./Demo";

const defaults: DemoProps = {
  repoUrl: "https://github.com/numinousmuses/basis-amm",
  testnetContract: "",
  testnetSteps: 0,
};

export const RemotionRoot: React.FC = () => (
  <Composition id="BasisDemo" component={BasisDemo} durationInFrames={TOTAL} fps={30} width={1920} height={1080} defaultProps={defaults} />
);
