// lib/disease.ts
// Tiền xử lý ảnh + đọc kết quả cho model MobileNetV3-Large (TFLite) nhận diện bệnh dâu.
//
// Theo inference_config.json lúc train:
//  - Input: 224x224x3, RGB, float32, pixel giữ nguyên [0, 255] (KHÔNG chia 255, model đã chuẩn hoá bên trong)
//  - Resize: bilinear, kéo giãn thành hình vuông (không giữ tỉ lệ), đã xoay đúng hướng EXIF
//  - Output: 8 điểm softmax, thứ tự theo class_names.json

import * as ImageManipulator from 'expo-image-manipulator';
import { decode } from 'jpeg-js';
import { toByteArray } from 'base64-js';

// 3 file này copy từ thư mục output lúc train vào assets/model/
import classNamesJson from '../assets/model/class_names.json';
import labelsViJson from '../assets/model/labels_vi.json';

export const MODEL_INPUT_SIZE = 224;

const CLASS_NAMES = classNamesJson as string[];
const LABELS_VI = labelsViJson as Record<string, string>;

export interface Prediction {
  classId: number;
  className: string;
  labelVi: string;
  score: number; // 0..1 (softmax, chưa hiệu chuẩn)
}

export const HEALTHY_CLASS = 'healthy';

/**
 * Ảnh (uri) -> Float32Array độ dài 224*224*3, thứ tự RGB, giá trị 0..255.
 */
export async function imageUriToInput(uri: string): Promise<Float32Array> {
  // manipulateAsync tự xoay đúng hướng EXIF và resize (kéo giãn) về 224x224
  const resized = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE } }],
    { format: ImageManipulator.SaveFormat.JPEG, compress: 1, base64: true }
  );
  if (!resized.base64) {
    throw new Error('Không đọc được dữ liệu ảnh');
  }

  const { data, width, height } = decode(toByteArray(resized.base64), {
    useTArray: true,
    formatAsRGBA: true,
  });
  if (width !== MODEL_INPUT_SIZE || height !== MODEL_INPUT_SIZE) {
    throw new Error(`Kích thước ảnh sau resize không đúng (${width}x${height})`);
  }

  // RGBA -> RGB, bỏ kênh alpha, KHÔNG chia 255
  const input = new Float32Array(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3);
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    input[j++] = data[i];
    input[j++] = data[i + 1];
    input[j++] = data[i + 2];
  }
  return input;
}

/**
 * Điểm softmax (8 giá trị) -> danh sách dự đoán, sắp xếp từ cao xuống thấp.
 */
export function toPredictions(scores: ArrayLike<number>): Prediction[] {
  if (scores.length !== CLASS_NAMES.length) {
    throw new Error(
      `Số đầu ra của model (${scores.length}) không khớp class_names.json (${CLASS_NAMES.length})`
    );
  }
  return Array.from(scores, (score, classId) => {
    const className = CLASS_NAMES[classId];
    return { classId, className, labelVi: LABELS_VI[className] ?? className, score };
  }).sort((a, b) => b.score - a.score);
}
