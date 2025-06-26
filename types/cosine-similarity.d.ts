declare module 'cosine-similarity' {
  /**
   * Compute cosine similarity between two equal-length vectors.
   * @param a first vector
   * @param b second vector
   * @returns similarity in [–1, 1]
   */
  export default function cosineSimilarity(a: number[], b: number[]): number;
}
