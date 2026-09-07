package downloader

import (
	"path/filepath"
	"truedown/internal/profile"
)

// Existing focused store tests deliberately use flat isolated fixtures. Runtime
// stores receive explicit paths from the profile at application composition.
func newRuntimeSettingsStore(database string) (*runtimeSettingsStore, error) {
	return newRuntimeSettingsStoreAt(profile.File(filepath.Dir(database), profile.RuntimeSettings))
}
func newDownloadRulesStore(database string) (*downloadRulesStore, error) {
	return newDownloadRulesStoreAt(profile.File(filepath.Dir(database), profile.DownloadRules))
}
func newTaskDefaultsStore(database string) (*taskDefaultsStore, error) {
	return newTaskDefaultsStoreAt(profile.File(filepath.Dir(database), profile.TaskDefaults))
}
func newTrackerResearchModule(database string) (*trackerResearchModule, error) {
	return newTrackerResearchModuleAt(profile.File(filepath.Dir(database), profile.TrackerState))
}
func newModuleRegistry(database string) (*moduleRegistry, error) {
	return newModuleRegistryAt(profile.File(filepath.Dir(database), profile.Modules), filepath.Join(filepath.Dir(database), profile.ModulePackages))
}
