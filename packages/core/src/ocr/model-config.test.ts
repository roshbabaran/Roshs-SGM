import { describe, expect, it } from 'vitest';

import { parseDetConfig, parseRecConfig, parseYaml } from './model-config';

/** PP-OCRv6_small_det's inference.yml, as PaddlePaddle publishes it. */
const DET_YML = `Global:
  model_name: PP-OCRv6_small_det
Hpi:
  backend_configs:
    paddle_infer:
      trt_dynamic_shapes: &id001
        x:
        - - 1
          - 3
          - 32
          - 32
        - - 1
          - 3
          - 736
          - 736
    tensorrt:
      dynamic_shapes: *id001
PostProcess:
  box_thresh: 0.45
  max_candidates: 3000
  name: DBPostProcess
  thresh: 0.2
  unclip_ratio: 1.4
PreProcess:
  transform_ops:
  - DecodeImage:
      channel_first: false
      img_mode: BGR
  - DetLabelEncode: null
  - DetResizeForTest: null
  - NormalizeImage:
      mean:
      - 0.485
      - 0.456
      - 0.406
      order: hwc
      scale: 1./255.
      std:
      - 0.229
      - 0.224
      - 0.225
  - ToCHWImage: null
`;

/** The shape of PP-OCRv6_small_rec's inference.yml, with a few of its 18,710 characters. */
const REC_YML = `Global:
  model_name: PP-OCRv6_small_rec
PreProcess:
  transform_ops:
  - DecodeImage:
      channel_first: false
      img_mode: BGR
  - RecResizeImg:
      image_shape:
      - 3
      - 48
      - 320
PostProcess:
  name: CTCLabelDecode
  character_dict:
  - '!'
  - '"'
  - '#'
  - ''''
  - '0'
  - 1
  - '~'
  - a
  - ₱
  - 一
  - \u3000
`;

describe('model settings (inference.yml)', () => {
  it("reads the detector's thresholds and normalisation", () => {
    expect(parseDetConfig(DET_YML)).toEqual({
      modelName: 'PP-OCRv6_small_det',
      thresh: 0.2,
      boxThresh: 0.45,
      unclipRatio: 1.4,
      maxCandidates: 3000,
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      scale: 1 / 255,
    });
  });

  it("reads the recogniser's input size and keeps every dictionary entry as written", () => {
    const rec = parseRecConfig(REC_YML);
    expect(rec).toMatchObject({ modelName: 'PP-OCRv6_small_rec', height: 48, minWidth: 320 });
    // Index 0 is the CTC blank and the last class is a space.
    expect(rec.characters).toEqual(['', '!', '"', '#', "'", '0', '1', '~', 'a', '₱', '一', '　', ' ']);
  });

  it('follows anchors and aliases', () => {
    const doc = parseYaml(DET_YML) as { Hpi: { backend_configs: { paddle_infer: { trt_dynamic_shapes: unknown }; tensorrt: { dynamic_shapes: unknown } } } };
    const configs = doc.Hpi.backend_configs;
    expect(configs.tensorrt.dynamic_shapes).toEqual(configs.paddle_infer.trt_dynamic_shapes);
  });

  it('says what is missing from a broken file', () => {
    expect(() => parseRecConfig('Global:\n  model_name: x\n')).toThrow(/input size/);
  });
});
