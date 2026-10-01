export declare function appVersion(): {
  versionCode: number
  versionName: string
  /** false when the version came from an APP_VERSION_* override or a tree with no git metadata. */
  fromGit: boolean
}
