# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [0.4.0-beta1] 2019-03-05
# Added
- Added support for custom configurations (cmake_configurations.json)
- Added support for variables replacement for configuration elements (e.g. build directory)
- Added support for toolchain sepecification (via configuration)
- Added support for new CMake File API (CMake Version >= 3.14)

# Removed
- Removed `cmake.generatorToolset`, `cmake.generatorPlatform`, `cmake.buildTypes` (Use configuration file)
- Removed `cmake.configureEnviroment`, `cmake.buildEnvironment` (replaced with `cmake.env`)

# Changed
- Renamed `cmake.cacheEntries` to `cmake.variables` and updated type
- Changed build type selection to configuration selection
- Reworked internal model to support CMake Server and File API
- Use webpack to build extension

## [0.3.2] 2019-02-08
### Fixed
 - Windows path handling
 - Provide configuration on windows
 - Provide configuration for non-target files in project directory (merged project configuration)

## [0.3.1] 2019-02-06
### Fixed
- Added cpptools as dependency to resolve extension not starting
- Fix unlink for pipe on windows
- Fix empty include path error in cppprovider

## [0.3.0] 2019-02-06
### Added
- Add cpptools configuration provider

### Fixed
- Error reporting of cmake client
- Error handling of cmake server process and socket

## [0.2.1] 2019-01-22
### Fixed
- Fixed selecting subprojects

## [0.2.0] 2019-01-22
### Changed
- Use CMake codemodel internally
- Use full names for targets
- Show the type in target selection
- Hide imported and interface targets from target selection

### Added
- Option to bring CMake output to front automatically
- Option to reconfigure the project on changes to CMake files.

### Fixed
- Update internal model during configuration change
- Remove socket on exit

## [0.1.3] 2018-12-22
### Fixes
- Display correct project and target values on first run

## [0.1.2] 2018-12-21
### Fixed
- Fixed GCC diagnostic parsing and positioning
- Fixed Configurations for single config generators

### Added
- Added parsing for GCC include stack

## [0.1.1] 2018-12-20
- Add logo
- Update README.md

## [0.1.0] 2018-12-19
- Initial release